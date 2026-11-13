import { describe, expect, it } from 'vitest';
import { parseOsc133, parseOsc7, parseOsc7502, parseOsc9 } from './osc';

describe('parseOsc9', () => {
  it('returns the path from a 9;9 working-directory report', () => {
    expect(parseOsc9('9;C:\\Users\\x')).toBe('C:\\Users\\x');
  });

  it('keeps spaces in the path', () => {
    expect(parseOsc9('9;C:\\My Projects\\app')).toBe('C:\\My Projects\\app');
  });

  it('strips surrounding quotes', () => {
    expect(parseOsc9('9;"C:\\My Projects"')).toBe('C:\\My Projects');
  });

  it('keeps a drive root as-is', () => {
    expect(parseOsc9('9;C:\\')).toBe('C:\\');
  });

  it('returns null for other OSC 9 subcommands', () => {
    expect(parseOsc9('4;1;50')).toBeNull();
    expect(parseOsc9('9;')).toBeNull();
  });

  it('returns null for UNC, device, and other non-drive paths', () => {
    expect(parseOsc9('9;\\\\attacker\\share')).toBeNull();
    expect(parseOsc9('9;"\\\\attacker\\share\\repo"')).toBeNull();
    expect(parseOsc9('9;//attacker/share')).toBeNull();
    expect(parseOsc9('9;\\\\?\\UNC\\attacker\\share')).toBeNull();
    expect(parseOsc9('9;\\\\.\\C:\\x')).toBeNull();
    expect(parseOsc9('9;HKLM:\\Software')).toBeNull();
    expect(parseOsc9('9;relative\\dir')).toBeNull();
    expect(parseOsc9('9;C:')).toBeNull();
  });

  it('returns null for an empty path or a missing separator', () => {
    expect(parseOsc9('9;')).toBeNull();
    expect(parseOsc9('9;""')).toBeNull();
    expect(parseOsc9('9')).toBeNull();
    expect(parseOsc9('')).toBeNull();
  });
});

describe('parseOsc7', () => {
  it('maps a Git Bash /c/ path to a Windows path', () => {
    expect(parseOsc7('file://host/c/Users/x')).toBe('C:\\Users\\x');
  });

  it('maps a /C:/ path to a Windows path', () => {
    expect(parseOsc7('file://host/C:/Users/x')).toBe('C:\\Users\\x');
  });

  it('accepts an empty host', () => {
    expect(parseOsc7('file:///c/Users/x')).toBe('C:\\Users\\x');
  });

  it('upper-cases the drive letter', () => {
    expect(parseOsc7('file://h/d/work')).toBe('D:\\work');
  });

  it('decodes percent-encoded spaces', () => {
    expect(parseOsc7('file://h/c/My%20Projects/app')).toBe('C:\\My Projects\\app');
  });

  it('decodes percent-encoded characters in the drive form', () => {
    expect(parseOsc7('file://h/C%3A/Users/x')).toBe('C:\\Users\\x');
  });

  it('drops trailing slashes', () => {
    expect(parseOsc7('file://h/c/Users/x/')).toBe('C:\\Users\\x');
    expect(parseOsc7('file://h/C:/Users/x//')).toBe('C:\\Users\\x');
  });

  it('maps a drive root with or without a trailing slash', () => {
    expect(parseOsc7('file://h/c/')).toBe('C:\\');
    expect(parseOsc7('file://h/c')).toBe('C:\\');
    expect(parseOsc7('file://h/C:/')).toBe('C:\\');
  });

  it('returns null for paths with no Windows equivalent', () => {
    expect(parseOsc7('file://h/home/user')).toBeNull();
    expect(parseOsc7('file://h/tmp')).toBeNull();
    expect(parseOsc7('file://h/')).toBeNull();
    expect(parseOsc7('file://h/cc/Users')).toBeNull();
  });

  it('returns null for input that is not a file URL', () => {
    expect(parseOsc7('C:\\Users\\x')).toBeNull();
    expect(parseOsc7('http://h/c/Users')).toBeNull();
    expect(parseOsc7('file://h')).toBeNull();
    expect(parseOsc7('')).toBeNull();
  });

  it('returns null for malformed percent-encoding', () => {
    expect(parseOsc7('file://h/c/%E0%A4%A')).toBeNull();
  });

  it('returns null for segments that cannot be a Windows name', () => {
    expect(parseOsc7('file://h/c/a%3Ab')).toBeNull();
    expect(parseOsc7('file://h/c/a%5Cb')).toBeNull();
  });
});

describe('parseOsc133', () => {
  it('parses A, B, and C markers', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'A' });
    expect(parseOsc133('B')).toEqual({ kind: 'B' });
    expect(parseOsc133('C')).toEqual({ kind: 'C' });
  });

  it('parses D with and without an exit code', () => {
    expect(parseOsc133('D;0')).toEqual({ kind: 'D', exitCode: 0 });
    expect(parseOsc133('D;130')).toEqual({ kind: 'D', exitCode: 130 });
    expect(parseOsc133('D')).toEqual({ kind: 'D' });
    expect(parseOsc133('D;x')).toEqual({ kind: 'D' });
  });

  it('returns null for unknown kinds and garbage', () => {
    expect(parseOsc133('Z')).toBeNull();
    expect(parseOsc133('')).toBeNull();
    expect(parseOsc133('a')).toBeNull();
    expect(parseOsc133('garbage;1')).toBeNull();
  });
});

describe('parseOsc7502', () => {
  it('parses profile and region', () => {
    expect(parseOsc7502('aws;prod;us-east-1')).toEqual({ profile: 'prod', region: 'us-east-1' });
  });

  it('allows an empty profile or region', () => {
    expect(parseOsc7502('aws;;eu-west-1')).toEqual({ profile: '', region: 'eu-west-1' });
    expect(parseOsc7502('aws;dev;')).toEqual({ profile: 'dev', region: '' });
  });

  it('reports both fields empty so the caller can clear the context', () => {
    expect(parseOsc7502('aws;;')).toEqual({ profile: '', region: '' });
  });

  it('takes everything after the second semicolon as the region', () => {
    expect(parseOsc7502('aws;dev;a;b')).toEqual({ profile: 'dev', region: 'a;b' });
  });

  it('tolerates a missing region field', () => {
    expect(parseOsc7502('aws;dev')).toEqual({ profile: 'dev', region: '' });
  });

  it('ignores unknown providers and malformed payloads', () => {
    expect(parseOsc7502('gcp;p;r')).toBeNull();
    expect(parseOsc7502('aws')).toBeNull();
    expect(parseOsc7502('')).toBeNull();
    expect(parseOsc7502('awsx;p;r')).toBeNull();
  });
});
