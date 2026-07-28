export type WriteSetting = (key: string, value: string) => Promise<void>;

/**
 * Serialize writes for the same setting key so a slow earlier request cannot
 * overwrite a newer choice. Different keys remain independent.
 */
export function createSettingsWriter(write: WriteSetting): WriteSetting {
  const pending = new Map<string, Promise<void>>();

  return (key, value) => {
    const previous = pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => write(key, value));
    pending.set(key, current);

    const cleanup = () => {
      if (pending.get(key) === current) pending.delete(key);
    };
    void current.then(cleanup, cleanup);

    return current;
  };
}
