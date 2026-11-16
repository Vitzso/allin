/** A short, readable device label from a User-Agent. Only the label is kept, never the string. */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Firefox\/|FxiOS\//.test(ua)
    ? 'Firefox'
    : /Edg\/|EdgA\/|EdgiOS\//.test(ua)
      ? 'Edge'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const system = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : 'this device';
  return `${browser} on ${system}`;
}
