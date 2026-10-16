export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const forbidden = (m = 'Forbidden') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/** A system command or config operation failed. Message is safe to show to an admin. */
export class SysError extends Error {
  constructor(
    message: string,
    public detail = '',
  ) {
    super(message);
  }
}
