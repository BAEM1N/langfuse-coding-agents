import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { IngestionEvent } from './langfuse.ts';

const exec = promisify(execFile);

export interface GithubOptions {
  enabled: boolean;
  lookupPullRequest: boolean;
  repository?: string;
  ref?: string;
  sha?: string;
}

export interface GithubContext {
  repository: string;
  repositoryUrl: string;
  commit: string;
  commitUrl: string;
  branch?: string;
  pullRequest?: { number: number; url: string; baseBranch?: string };
}

export function githubOptions(env: NodeJS.ProcessEnv): GithubOptions {
  return {
    enabled: env.CODING_AGENT_GITHUB_METADATA !== 'false',
    lookupPullRequest: env.CODING_AGENT_GITHUB_PR_LOOKUP !== 'false',
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
  };
}

async function output(file: string, args: string[], cwd: string, timeout = 1000): Promise<string | undefined> {
  try {
    const { stdout } = await exec(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 256 * 1024 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function githubSlug(remote?: string): string | undefined {
  if (!remote) return;
  let path: string;
  const ssh = /^[^@\s]+@github\.com:(.+)$/i.exec(remote);
  if (ssh) {
    path = ssh[1];
  } else {
    try {
      const url = new URL(remote);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname !== 'github.com') return;
      path = url.pathname.replace(/^\//, '');
    } catch {
      return;
    }
  }
  const slug = path.replace(/\/$/, '').replace(/\.git$/i, '');
  return /^[\w.-]+\/[\w.-]+$/.test(slug) && !slug.split('/').some(part => part === '.' || part === '..') ? slug : undefined;
}

interface PullRequest {
  number: number;
  head?: { sha?: string };
  base?: { ref?: string; repo?: { full_name?: string } };
  merge_commit_sha?: string;
}

export function matchingPullRequest(value: unknown, repository: string, commit: string): PullRequest | undefined {
  if (!Array.isArray(value)) return;
  const matches = (value as PullRequest[]).filter(pr => pr && Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase()
    && (pr.head?.sha === commit || pr.merge_commit_sha === commit));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readGithubContext(cwd: string, options: GithubOptions): Promise<GithubContext | undefined> {
  if (!options.enabled || !isAbsolute(cwd)) return;
  const [remote, commit, branch] = await Promise.all([
    output('git', ['config', '--get', 'remote.origin.url'], cwd),
    output('git', ['rev-parse', '--verify', 'HEAD'], cwd),
    output('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd),
  ]);
  const repository = githubSlug(remote);
  if (!repository || !commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return;
  const repositoryUrl = 'https://github.com/' + repository;
  const context: GithubContext = { repository, repositoryUrl, commit, commitUrl: repositoryUrl + '/commit/' + commit, branch };
  const prRef = options.repository?.toLowerCase() === repository.toLowerCase() && options.sha === commit
    ? /^refs\/pull\/([1-9]\d*)\/(?:head|merge)$/.exec(options.ref ?? '') : null;
  if (prRef && Number.isSafeInteger(Number(prRef[1]))) {
    context.pullRequest = { number: Number(prRef[1]), url: repositoryUrl + '/pull/' + prRef[1] };
  } else if (options.lookupPullRequest) {
    const json = await output('gh', ['api', '--hostname', 'github.com', 'repos/' + repository + '/commits/' + commit + '/pulls'], cwd, 2500);
    if (json) {
      try {
        const pr = matchingPullRequest(JSON.parse(json), repository, commit);
        if (pr) context.pullRequest = { number: pr.number, url: repositoryUrl + '/pull/' + pr.number, baseBranch: pr.base?.ref };
      } catch {
        // GitHub context is optional when the API is unavailable.
      }
    }
  }
  return context;
}

export function githubAttributes(github: GithubContext) {
  return {
    'vcs.repository.url.full': github.repositoryUrl,
    'vcs.repository.name': github.repository.split('/')[1],
    'vcs.ref.head.revision': github.commit,
    'vcs.ref.head.name': github.branch,
    'vcs.ref.base.name': github.pullRequest?.baseBranch,
    'vcs.change.id': github.pullRequest && String(github.pullRequest.number),
    'github.repository': github.repository,
    'github.commit.url': github.commitUrl,
    'github.pull_request.url': github.pullRequest?.url,
  };
}

export async function enrichGithub(events: IngestionEvent[], options: GithubOptions, cwd: string): Promise<void> {
  if (!options.enabled) return;
  const pending = new Map<string, ReturnType<typeof readGithubContext>>();
  await Promise.all(events.filter(event => event.type === 'trace-create').map(async ({ body }) => {
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    if ('github' in metadata) return;
    const directory = typeof metadata.cwd === 'string' && isAbsolute(metadata.cwd) ? metadata.cwd : cwd;
    let lookup = pending.get(directory);
    if (!lookup) {
      lookup = readGithubContext(directory, options);
      pending.set(directory, lookup);
    }
    const github = await lookup;
    if (github) body.metadata = { ...metadata, github };
  }));
}
