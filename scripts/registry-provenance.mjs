// This checks the Registry's provenance statement against the reviewed source
// and bytes. npm's Registry verifies the Sigstore bundle on publication.
export function validateRegistryProvenance(attestations, item, revision) {
  const attestation = attestations?.attestations?.find(value => value.predicateType === 'https://slsa.dev/provenance/v1');
  const encoded = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof encoded !== 'string') throw new Error(`${item.name}: missing SLSA provenance payload`);
  const statement = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
  const expectedDigest = Buffer.from(item.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const expectedName = `pkg:npm/${item.name.replace('@', '%40')}@${item.version}`;
  if (statement._type !== 'https://in-toto.io/Statement/v1' ||
      statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
      statement.subject?.length !== 1 || statement.subject[0].name !== expectedName ||
      statement.subject[0].digest?.sha512 !== expectedDigest ||
      workflow?.repository !== 'https://github.com/Gao-Sijie/muha' ||
      workflow.path !== '.github/workflows/sdk-release.yml' || workflow.ref !== 'refs/heads/main' ||
      !Array.isArray(dependencies) || !dependencies.some(value =>
        value.uri === 'git+https://github.com/Gao-Sijie/muha@refs/heads/main' && value.digest?.gitCommit === revision) ||
      statement.predicate?.runDetails?.builder?.id !== 'https://github.com/actions/runner/github-hosted') {
    throw new Error(`${item.name}: provenance does not bind the reviewed source, workflow and artifact`);
  }
}
