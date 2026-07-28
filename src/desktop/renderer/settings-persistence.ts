export function makeSerializableSetting<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("设置值无法序列化");
  return JSON.parse(serialized) as T;
}

export function settingValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
