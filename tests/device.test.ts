import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceName } from '../shared/device.ts';

const cases: [string, string | undefined][] = [
  ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'],
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  ],
  [
    'Chrome on Mac',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ],
  [
    'Safari on Mac',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  ],
  [
    'Safari on iPhone',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  ],
  [
    'Safari on iPad',
    'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  ],
  [
    'Chrome on Android',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  ],
  [
    'Chrome on Linux',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  ],
  ['Browser on this device', undefined],
  ['Browser on this device', ''],
  ['Browser on this device', 'curl/8.4.0'],
];
for (const [expected, ua] of cases)
  test(`the label is "${expected}" for ${ua?.slice(0, 40) ?? 'no User-Agent'}`, () => {
    assert.equal(deviceName(ua), expected);
  });
