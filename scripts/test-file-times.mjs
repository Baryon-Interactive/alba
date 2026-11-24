import path from 'node:path';

// The outer file completion includes module loading, all subtests and teardown.
export default async function* fileTimes(events) {
  for await (const { type, data } of events) {
    if (type === 'test:complete' && data.file && path.resolve(data.name) === path.resolve(data.file)) {
      yield JSON.stringify({ name: path.basename(data.file), ms: data.details.duration_ms }) + '\n';
    }
  }
}
