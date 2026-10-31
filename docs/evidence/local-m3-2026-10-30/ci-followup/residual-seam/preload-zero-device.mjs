// Preload: reproduce the hosted Windows runner path-metadata split locally.
// lstatSync (path API) reports dev 0 for every entry while fstatSync (handle
// API) keeps its native nonzero device, exactly as recorded in CI diagnostic
// metadata for runs 39fe7c1/1f3bd47/f4d1bd3. fstat is left untouched.
import fs from 'node:fs';
if (process.platform === 'win32') {
  const original = fs.lstatSync;
  fs.lstatSync = (...args) => {
    const stat = original(...args);
    return stat && Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
      { dev: stat.dev === undefined ? undefined : (typeof stat.dev === 'bigint' ? 0n : 0) });
  };
}
