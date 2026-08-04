/**
 * Turning what a developer writes into the URL an installed app fetches.
 *
 * A feed is always a **public HTTP location** (or a local directory, for
 * testing). Where it is hosted is not Vidra's concern: S3, R2, nginx, GitHub
 * Pages and a box under a desk are all the same thing to a client that does a
 * plain `GET`. So this is deliberately not a driver layer. It is a small set of
 * shorthands for URLs that are long, mechanical and easy to typo.
 *
 * **The resolved URL is stamped into every build and lives in every install
 * forever**, so these rules are a permanent API. Adding a shorthand is cheap.
 * Changing what an existing one resolves to is not, because apps built last
 * year keep fetching the old address.
 *
 * That is also why there is no `s3:` here. A bucket's public URL is only
 * derivable for AWS at its default endpoint; anyone behind CloudFront, R2 or a
 * custom domain would have a guess baked into their installs. Those users write
 * the `https://` they actually serve, which costs them nothing.
 */

/** `github:owner/repo` or `github:owner/repo@tag`. */
const GITHUB = /^github:([^/\s]+)\/([^/@\s]+)(?:@([^\s]+))?$/i;

/**
 * The release tag a bare `github:owner/repo` points at.
 *
 * One pinned release holds the indexes and payloads, and per-version releases
 * stay for humans with the installers attached. Deliberately not GitHub's
 * `releases/latest/download/` alias: older archives live under their own tags,
 * so `latest` silently 404s for whoever is furthest behind.
 */
export const DEFAULT_GITHUB_TAG = "updates";

export class FeedUriError extends Error {}

/**
 * Resolves a configured feed to the base every payload sits under.
 *
 * Always ends in a separator, so a file name can be appended without deciding
 * whose job the slash is.
 */
export const resolveFeedUri = (uri: string): string => {
  const trimmed = uri.trim();
  if (trimmed.length === 0) {
    throw new FeedUriError("a feed URL cannot be empty");
  }

  const github = GITHUB.exec(trimmed);
  if (github) {
    const [, owner, repo, tag] = github;
    return `https://github.com/${owner}/${repo}/releases/download/${tag ?? DEFAULT_GITHUB_TAG}/`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return withTrailingSlash(trimmed);
  }

  // An unknown `scheme:` is a typo or a shorthand we do not ship, and guessing
  // at it would bake a wrong URL into every install. A Windows drive letter is
  // one character, and is a path rather than a scheme.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1];
  if (scheme && scheme.length > 1) {
    throw new FeedUriError(
      `unknown feed scheme '${scheme}:' — use an https:// URL, a local path, or github:owner/repo`,
    );
  }

  // A local directory is as legitimate a feed as a URL: a mounted share, or a
  // directory a test serves from. The host reads either.
  return withTrailingSlash(trimmed);
};

/** Appends a channel, which is a path segment rather than a label. */
export const withChannel = (base: string, channel: string | null): string =>
  channel ? `${base}${channel}/` : base;

/** Where `bundles.json` lives under a resolved base. */
export const manifestUrlFor = (base: string): string => `${base}bundles.json`;

const withTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;
