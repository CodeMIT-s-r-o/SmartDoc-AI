import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { isDuplicateUpload, sha256Hex, uploadErrorMessage } from './api';

describe('sha256Hex', () => {
  it('matches the standard test vectors', async () => {
    expect(await sha256Hex(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('duplicate uploads', () => {
  it('are reported as information, not as a failure', () => {
    const duplicate = new ApiError(409, 'DUPLICATE_DOCUMENT', 'already uploaded');

    expect(isDuplicateUpload(duplicate)).toBe(true);
    expect(uploadErrorMessage(duplicate)).toBe('This file is already in your documents.');
    expect(isDuplicateUpload(new ApiError(422, 'QUOTA_EXCEEDED', 'full'))).toBe(false);
  });
});
