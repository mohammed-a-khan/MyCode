import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { aesEncryptBlock, expandKey, queryCipher, reportCipher } from '../src/crystal/crypto.ts';
import { buildDataSource, buildReportDefinition } from '../src/crystal/model.ts';
import { parseRecords, serializeRecords, type RecordNode } from '../src/crystal/records.ts';
import { decodeStream, encodeStream, logicalBytes } from '../src/crystal/streams.ts';
import { encodeString, stringsIn, tokenize } from '../src/crystal/strings.ts';
import { jsonToRpt, readCfb, rptToJson, writeCfb, type CfbDocument, type RptJson } from '../src/index.ts';

const ZERO = '00000000-0000-0000-0000-000000000000';
const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** A nested report record: flags 0xF8 (4-byte length, schema, strings, masked), schema 0x0700. */
function record(type: number, ...parts: (Uint8Array | RecordNode)[]): RecordNode {
  return { flags: 0xf8 | (type >> 8), type, schema: 0x0700, parts };
}

describe('AES-128 implementation', () => {
  it('matches the FIPS-197 appendix C.1 vector', () => {
    const block = Uint8Array.from(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
    aesEncryptBlock(block, expandKey(Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'))));
    assert.equal(Buffer.from(block).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
  });

  it('agrees with an independent AES for random keys and blocks', () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(16);
      const input = randomBytes(16);
      const block = Uint8Array.from(input);
      aesEncryptBlock(block, expandKey(key));
      const expected = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false).update(input);
      assert.deepEqual(Buffer.from(block), expected);
    }
  });

  it('CFB encryption and decryption are inverses for any length', () => {
    const iv = randomBytes(16);
    for (const length of [0, 1, 15, 16, 17, 33, 1000]) {
      const plain = randomBytes(length);
      for (const cipher of [reportCipher, queryCipher]) {
        const encrypted = cipher.encrypt(iv, plain);
        assert.equal(encrypted.length, length);
        assert.deepEqual(Buffer.from(cipher.decrypt(iv, encrypted)), plain);
      }
    }
  });
});

describe('length-prefixed strings', () => {
  it('tokenises losslessly and prefers a real string over an overlapping empty one', () => {
    const data = bytes([0, 0], [0, 0, 0, 0, 0, 1], encodeString('PageHeaderArea1'), [0xff, 0xff], encodeString(''), [1, 2]);
    const tokens = tokenize(data);
    assert.ok(tokens.some((t) => 'text' in t && t.text === 'PageHeaderArea1'));
    const rebuilt = Buffer.concat(tokens.map((t) => ('text' in t ? encodeString(t.text) : t.bytes)));
    assert.deepEqual(rebuilt, Buffer.from(data));
    assert.deepEqual(stringsIn(encodeString('héllo wörld')), ['héllo wörld']);
  });
});

describe('record framing', () => {
  const tree: RecordNode[] = [
    record(0x0077, bytes([0, 0, 0, 0]), record(0x0076, record(0x0071, encodeString('Discount'), bytes([7, 0, 8])), bytes([0, 1]), encodeString('Orders.Amount'), bytes([2, 0, 0]), encodeString('{Orders.Amount} * 0.9'))),
    { flags: 0x39, type: 0x0151, schema: 0x0700, parts: [] },
    record(0x008a, bytes([0, 0]), encodeString('DetailArea1')),
  ];

  it('parses serialised records back to the same tree and bytes', () => {
    const data = serializeRecords({ records: tree, trailing: new Uint8Array(0) });
    const parsed = parseRecords(data, 'report');
    assert.deepEqual(serializeRecords(parsed), data);
    assert.equal(parsed.records.length, 3);
    const formula = parsed.records[0].parts.find((p) => !(p instanceof Uint8Array)) as RecordNode;
    assert.equal(formula.type, 0x0076);
    assert.equal((formula.parts[0] as RecordNode).type, 0x0071);
  });

  it('reproduces arbitrary bytes exactly, whatever the parser makes of them', () => {
    for (let i = 0; i < 50; i++) {
      const noise = randomBytes(200 + i * 7);
      const data = bytes([0xf8, 0x10, 0x07, 0x00, 0, 0, 0, noise.length], noise);
      assert.deepEqual(Buffer.from(serializeRecords(parseRecords(data, 'report'))), Buffer.from(data));
    }
  });

  it('extracts formulas and layout into the report model', () => {
    const definition = buildReportDefinition(parseRecords(serializeRecords({ records: tree, trailing: new Uint8Array(0) }), 'report').records);
    assert.deepEqual(definition.formulas, [{ name: 'Discount', index: 0, kind: 'formula', text: '{Orders.Amount} * 0.9', referencedFields: ['Orders.Amount'] }]);
    assert.equal(definition.layout[0].name, 'DetailArea1');
  });

  it('extracts connections, tables, stored procedures, commands and joins from a query session', () => {
    const field = (id: number, name: string, type: number, length: number) =>
      record(0x0004, bytes([0, 0, 0, id]), encodeString(name), encodeString(''), bytes([0, 0, 0, type, 0, 0, 0, length]));
    const table = (id: number, alias: string, name: string, ...fields: RecordNode[]) =>
      record(0x0003, bytes([0, 0, 0, id]), encodeString(alias), encodeString(''), encodeString(name), ...fields);
    // A connection property's value sits in a nested record written without a schema word (flag 0xD8).
    const value = encodeString('SQLPROD01');
    const valueRecord = bytes([0xd8, 0x0b, 0, 0, 0, value.length], value.map((b) => b ^ 0x0b));
    const property = record(0x0009, bytes([0, 0, 0, 1]), encodeString('Server'), encodeString('Server'), encodeString(''), valueRecord);
    const records = [
      record(0x0001, bytes([0, 0, 0, 1]),
        record(0x0002, encodeString('crdb_ado.dll'), encodeString('OLE DB (ADO)'), encodeString('Sales'), property,
          table(0x10, 'Orders', 'dbo.Orders', field(0x11, 'Order ID', 4, 4), field(0x12, 'Customer ID', 4, 4)),
          table(0x20, 'Customer', 'Customer', field(0x21, 'Customer ID', 4, 4), field(0x22, 'Name', 11, 102)),
          table(0x30, 'usp_Totals;1', 'usp_Totals;1', field(0x31, 'Total', 7, 8)),
          table(0x40, 'Command', 'SELECT Name FROM Customer WHERE Active = 1', field(0x41, 'Name', 11, 102))),
        record(0x000a, bytes([0, 0, 0, 0x50, 0, 0, 0, 0x12, 0, 0, 0, 0x21, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 1]))),
    ];
    for (const r of records) (function setSchema(n: RecordNode) { n.schema = 0x0905; n.parts.forEach((p) => p instanceof Uint8Array || setSchema(p)); })(r);
    const source = buildDataSource(parseRecords(serializeRecords({ records, trailing: new Uint8Array(0) }), 'query').records);

    assert.deepEqual(source.connections, [{ driverLibrary: 'crdb_ado.dll', driver: 'OLE DB (ADO)', database: 'Sales', properties: { Server: 'SQLPROD01' } }]);
    assert.deepEqual(source.tables.map((t) => [t.alias, t.name, t.kind, t.schema, t.sql]), [
      ['Orders', 'Orders', 'table', 'dbo', undefined],
      ['Customer', 'Customer', 'table', undefined, undefined],
      ['usp_Totals;1', 'usp_Totals;1', 'storedProcedure', undefined, undefined],
      ['Command', 'Command', 'command', undefined, 'SELECT Name FROM Customer WHERE Active = 1'],
    ]);
    assert.deepEqual(source.tables[1].fields, [{ name: 'Customer ID', type: 'integer', length: 4 }, { name: 'Name', type: 'string', length: 102 }]);
    assert.deepEqual(source.links, [
      { from: { table: 'Orders', field: 'Customer ID' }, to: { table: 'Customer', field: 'Customer ID' }, join: 'inner', operator: '=', codes: [4, 1, 1] },
    ]);
  });
});

describe('encrypted streams', () => {
  // Stream header record: flags 0xFC (4-byte length, schema, masked, extended type 0xFFFF).
  const iv = randomBytes(16);
  const headerContent = bytes([0, 1, 1, 0, 0, 1], iv, [0, 0]);
  const header = bytes([0xfc, 0x00, 0xff, 0xff, 0x07, 0x00, 0, 0, 0, headerContent.length], headerContent.map((b) => b ^ 0xff));
  const logical = serializeRecords({
    records: [record(0x0077, bytes([0, 0, 0, 0]), record(0x0076, record(0x0071, encodeString('F1'), bytes([6, 0, 8])), bytes([0, 0]), encodeString('1 + 1')))],
    trailing: new Uint8Array(0),
  });
  const { deflateSync } = process.getBuiltinModule('node:zlib') as typeof import('node:zlib');
  const contents = Buffer.concat([header, reportCipher.encrypt(iv, deflateSync(logical))]);

  it('decodes and re-encodes a Contents stream', () => {
    const decoded = decodeStream('contents', contents);
    assert.deepEqual(Buffer.from(logicalBytes(decoded)[0]), Buffer.from(logical));
    const again = decodeStream('contents', encodeStream(decoded));
    assert.deepEqual(Buffer.from(logicalBytes(again)[0]), Buffer.from(logical));
  });

  it('decodes a multi-document PromptManager stream', () => {
    const docs = ['<CRMetaObjects>a</CRMetaObjects>', '<CRMetaObjects>b</CRMetaObjects>'];
    const raw = Buffer.concat(docs.map((d) => reportCipher.encrypt(new Uint8Array(16), deflateSync(d))));
    const decoded = decodeStream('promptManager', raw);
    assert.ok(decoded.kind === 'promptManager');
    assert.deepEqual(decoded.documents.map((d) => Buffer.from(d).toString()), docs);
  });

  it('round-trips through JSON: unchanged streams stay byte-identical, edited ones are re-encrypted', () => {
    const doc: CfbDocument = {
      majorVersion: 3,
      minorVersion: 0x3e,
      root: {
        type: 'storage', name: 'Root Entry', clsid: ZERO, stateBits: 0, created: null, modified: null,
        children: [{ type: 'stream', name: 'Contents', clsid: ZERO, stateBits: 0, created: null, modified: null, data: contents }],
      },
    };
    const json = rptToJson(writeCfb(doc));
    const contentsOf = (j: RptJson) => j.root.children.find((c) => c.name === 'Contents');

    const unchanged = readCfb(jsonToRpt(structuredClone(json)));
    assert.deepEqual(Buffer.from((unchanged.root.children[0] as { data: Uint8Array }).data), contents);

    const edited = structuredClone(json);
    const stream = contentsOf(edited);
    assert.ok(stream?.type === 'stream' && stream.decoded?.kind === 'contents');
    const text = JSON.stringify(stream.decoded).replace('"1 + 1"', '"2 + 2"');
    stream.decoded = JSON.parse(text);
    const rebuilt = rptToJson(jsonToRpt(edited));
    assert.equal(rebuilt.metadata?.reports?.[0].definition?.formulas[0].text, '2 + 2');
  });
});
