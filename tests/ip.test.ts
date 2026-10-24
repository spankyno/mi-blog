import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cidrContains, ipv6Slash64, parseCidr, parseIp } from '../src/lib/defense/ip';
import { addToList, emptyList, findMatch, normalizeValue } from '../src/lib/defense/blocklist';

describe('parseIp', () => {
  it('IPv4 válida e inválida', () => {
    assert.equal(parseIp('45.138.12.27')?.text, '45.138.12.27');
    assert.equal(parseIp('256.1.1.1'), null);
    assert.equal(parseIp(''), null);
    assert.equal(parseIp(null), null);
  });
  it('IPv6: comprime, acepta ::, IPv4 incrustada y rechaza basura', () => {
    assert.equal(parseIp('2001:41d0:0701:1100:0000:0000:0000:52d6')?.text, '2001:41d0:701:1100::52d6');
    assert.equal(parseIp('::1')?.text, '::1');
    assert.equal(parseIp('::')?.text, '::');
    assert.equal(parseIp('::ffff:1.2.3.4')?.text, '::ffff:102:304');
    assert.equal(parseIp('1:2:3'), null);
    assert.equal(parseIp('1::2::3'), null);
  });
});

describe('CIDR', () => {
  it('normaliza al inicio de la red', () => {
    assert.equal(parseCidr('45.138.12.99/24')?.text, '45.138.12.0/24');
  });
  it('rechaza prefijos peligrosos (/0, IPv6 menor que /16)', () => {
    assert.equal(parseCidr('0.0.0.0/0'), null);
    assert.equal(parseCidr('2001::/8'), null);
  });
  it('contiene / no contiene', () => {
    const c = parseCidr('45.138.12.0/24')!;
    assert.equal(cidrContains(c, parseIp('45.138.12.16')!), true);
    assert.equal(cidrContains(c, parseIp('45.138.13.16')!), false);
  });
  it('IPv6: /64 y no mezcla familias', () => {
    const ip = parseIp('2001:41d0:701:1100::52d6')!;
    assert.equal(ipv6Slash64(ip), '2001:41d0:701:1100::/64');
    assert.equal(cidrContains(parseCidr('2001:41d0:701:1100::/64')!, parseIp('2001:41d0:701:1100:aaaa:bbbb:cccc:dddd')!), true);
    assert.equal(cidrContains(parseCidr('2001:41d0:701:1100::/64')!, parseIp('1.2.3.4')!), false);
  });
});

describe('normalizeValue y listas', () => {
  it('ASN y país', () => {
    assert.equal(normalizeValue('asn', 'AS16276'), '16276');
    assert.equal(normalizeValue('country', 'pl'), 'PL');
    assert.equal(normalizeValue('country', 'POL'), null);
  });
  it('findMatch: IP exacta, CIDR, ASN, país y sin coincidencia', () => {
    const l = emptyList();
    addToList(l, { kind: 'ip', value: '1.2.3.4', source: 'manual' });
    addToList(l, { kind: 'cidr', value: '45.138.12.0/24', source: 'manual' });
    addToList(l, { kind: 'asn', value: '16276', source: 'manual' });
    addToList(l, { kind: 'country', value: 'XX', source: 'manual' });
    assert.ok(findMatch(l, { ip: parseIp('1.2.3.4') }));
    assert.ok(findMatch(l, { ip: parseIp('45.138.12.16') }));
    assert.ok(findMatch(l, { ip: parseIp('9.9.9.9'), asn: 16276 }));
    assert.ok(findMatch(l, { ip: parseIp('9.9.9.9'), country: 'xx' }));
    assert.equal(findMatch(l, { ip: parseIp('9.9.9.9'), asn: 1, country: 'ES' }), null);
  });
});
