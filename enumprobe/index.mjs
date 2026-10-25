import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const stamp = process.env.GITHUB_RUN_ID;
const types = [
  'application/json','application/zip','application/octet-stream','text/plain','text/html',
  'application/xml','text/xml','application/reports+json','application/ld+json','application/vnd.api+json',
  'application/problem+json','application/geo+json','application/manifest+json','application/json-patch+json',
  'application/merge-patch+json','text/json','application/javascript','text/javascript','application/pdf',
  'image/png','image/svg+xml','application/gzip','application/x-tar','text/csv','application/yaml',
  'application/graphql','message/http','multipart/form-data','application/x-www-form-urlencoded',
  'application/vnd.github+json','application/vnd.github.v3+json','application/atom+xml','text/event-stream',
];
let i = 0;
for (const t of types) {
  i += 1;
  const name = `enum-${stamp}-${i}.json`;
  try {
    const created = await client.CreateArtifact({...ids, name, version: 7, mimeType: StringValue.create({value: t})});
    console.log('ENUM', JSON.stringify({type: t, ok: !!created.ok}));
  } catch (error) {
    console.log('ENUM', JSON.stringify({type: t, ok: false, error: String(error.message || error).slice(0, 90)}));
  }
}
