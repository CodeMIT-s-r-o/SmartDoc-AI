/** Postgres unique_violation (23505), also when Drizzle wraps the driver error in `cause`. */
export const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  const pgError = (e: unknown) => e as { code?: string; constraint?: string } | undefined;
  const found = [pgError(error), pgError((error as { cause?: unknown } | undefined)?.cause)].find(
    (e) => e?.code === '23505',
  );
  return found !== undefined && (constraint === undefined || found.constraint === constraint);
};
