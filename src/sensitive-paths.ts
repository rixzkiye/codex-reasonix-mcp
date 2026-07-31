const PRIVATE_DIRECTORY = new Set(['.aws', '.azure', '.docker', '.gnupg', '.kube', '.ssh']);

const CREDENTIAL_BASENAME =
  /^(?:\.env(?:\..+)?|\.netrc|\.npmrc|\.pypirc|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|kubeconfig|service[-_]?account.*\.json|.*\.(?:jks|keystore|p12|pfx|key|pem))$/i;

function segments(repositoryPath: string): string[] {
  return repositoryPath.replaceAll('\\', '/').split('/').filter(Boolean);
}

export function isGitControlPath(repositoryPath: string): boolean {
  return segments(repositoryPath).some((segment) => segment.toLowerCase() === '.git');
}

export function isCredentialPath(repositoryPath: string): boolean {
  const parts = segments(repositoryPath);
  const basename = parts.at(-1) ?? '';
  if (parts.some((segment) => PRIVATE_DIRECTORY.has(segment.toLowerCase()))) return true;
  if (/^\.env\.(?:example|sample|template)$/i.test(basename)) return false;
  return CREDENTIAL_BASENAME.test(basename);
}
