export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

// Saved data that can't be read is a fault on this device, not a problem with the request.
export function readStored<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      500,
      'Some saved data in your vault could not be read and may be damaged. Leave your files in place and restore a backup into a clean profile.',
      error,
    );
  }
}
