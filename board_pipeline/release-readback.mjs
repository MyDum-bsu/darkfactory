import { request } from 'node:http';
import { isVersion, ReleaseDenied } from './release-contract.mjs';
import { ARTIFACT_LIMIT, digestBytes } from './release-target.mjs';

export const RELEASE_INSTANCE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const RELEASE_OPERATION = /^[a-f0-9]{64}$/;

export function releaseEndpoint(url) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(url)) {
    throw new ReleaseDenied('release_endpoint_invalid');
  }
  const port = Number(url.split(':').at(-1));
  if (port === 44100 || port > 65535) throw new ReleaseDenied('release_endpoint_invalid');
  return port;
}

async function getReleaseResponse(port, path, limit) {
  try {
    const response = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', agent: false,
        signal: AbortSignal.timeout(5000) }, resolve);
      req.once('error', reject);
      req.end();
    });
    if (response.statusCode !== 200) {
      response.destroy();
      throw new ReleaseDenied('release_target_readback_failed');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit) throw new ReleaseDenied('release_target_reply_too_large');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  } catch (cause) {
    if (cause instanceof ReleaseDenied) throw cause;
    throw new ReleaseDenied('release_target_unreachable', { cause });
  }
}

export function releaseReader(url) {
  const port = releaseEndpoint(url);
  return {
    async readBack({ target, instance }) {
      const reply = await getReleaseResponse(port, '/version', 2048);
      let live;
      try { live = JSON.parse(reply.bytes.toString('utf8')); }
      catch (cause) { throw new ReleaseDenied('release_readback_invalid', { cause }); }
      if (!isVersion(live) || live.target !== target || live.instance !== instance ||
          (live.operation !== null && (typeof live.operation !== 'string' || !RELEASE_OPERATION.test(live.operation)))) {
        throw new ReleaseDenied('release_readback_invalid');
      }
      return { sha: live.sha, digest: live.digest, operation: live.operation };
    },
    async readArtifact(expected, instance) {
      const { bytes, headers } = await getReleaseResponse(port, '/artifact', ARTIFACT_LIMIT);
      if (headers['x-release-instance'] !== instance || headers['x-release-sha'] !== expected.sha ||
          headers['x-release-digest'] !== expected.digest || headers['x-release-operation'] !== (expected.operation ?? '') ||
          digestBytes(bytes) !== expected.digest) throw new ReleaseDenied('release_smoke_version_changed');
      return { bytes, contentType: headers['content-type'] };
    },
  };
}
