import { EXIT_CODES } from './constants.mjs';

export class MwtError extends Error {
  constructor({
    code = EXIT_CODES.GENERIC_FAILURE,
    id = 'mwt_error',
    message,
    details = {},
    cause,
  }) {
    super(message);
    this.name = 'MwtError';
    this.code = code;
    this.id = id;
    this.details = details;
    this.cause = cause;
  }
}

export function asMwtError(error) {
  if (error instanceof MwtError) {
    return error;
  }

  if (error instanceof Error) {
    return new MwtError({
      message: error.message,
      cause: error,
    });
  }

  return new MwtError({
    message: String(error),
  });
}
