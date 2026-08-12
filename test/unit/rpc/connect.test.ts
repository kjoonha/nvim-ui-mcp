import { describe, expect, it } from 'vitest';
import { buildLaunchArgs, normalizePipeAddress } from '../../../src/rpc/connect.js';

describe('buildLaunchArgs', () => {
  it('always embeds and disables swap files', () => {
    expect(buildLaunchArgs({})).toEqual(['--embed', '-n']);
  });

  it('adds --clean when asked', () => {
    expect(buildLaunchArgs({ clean: true })).toEqual(['--embed', '-n', '--clean']);
  });

  it('passes an init file with -u', () => {
    expect(buildLaunchArgs({ init: '/tmp/init.lua' })).toEqual([
      '--embed',
      '-n',
      '-u',
      '/tmp/init.lua',
    ]);
  });

  it('prefers --clean over an init file', () => {
    expect(buildLaunchArgs({ clean: true, init: '/tmp/init.lua' })).toEqual([
      '--embed',
      '-n',
      '--clean',
    ]);
  });

  it('places the file after extra arguments', () => {
    expect(buildLaunchArgs({ args: ['--noplugin'], file: 'a.txt' })).toEqual([
      '--embed',
      '-n',
      '--noplugin',
      'a.txt',
    ]);
  });
});

describe('normalizePipeAddress', () => {
  it('leaves Unix socket paths untouched', () => {
    expect(normalizePipeAddress('/tmp/nvim.sock', 'linux')).toBe('/tmp/nvim.sock');
    expect(normalizePipeAddress('/tmp/nvim.sock', 'darwin')).toBe('/tmp/nvim.sock');
  });

  it('never rewrites anything off Windows, even a pipe-shaped path', () => {
    expect(normalizePipeAddress('//./pipe/nvim.123.0', 'linux')).toBe('//./pipe/nvim.123.0');
  });

  it('converts forward slashes in a Windows named pipe', () => {
    expect(normalizePipeAddress('//./pipe/nvim.123.0', 'win32')).toBe('\\\\.\\pipe\\nvim.123.0');
  });

  it('accepts a pipe path that is already backslashed', () => {
    expect(normalizePipeAddress('\\\\.\\pipe\\nvim.123.0', 'win32')).toBe(
      '\\\\.\\pipe\\nvim.123.0',
    );
  });

  it('handles the ? form of the device namespace', () => {
    expect(normalizePipeAddress('//?/pipe/nvim.1.0', 'win32')).toBe('\\\\?\\pipe\\nvim.1.0');
  });

  it('leaves a Windows drive path alone', () => {
    expect(normalizePipeAddress('C:/Users/me/nvim.sock', 'win32')).toBe('C:/Users/me/nvim.sock');
  });
});
