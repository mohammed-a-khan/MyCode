/**
 * Crystal Reports .rpt <-> JSON converter.
 *
 * rptToJson() turns a .rpt file into a JSON object holding every storage, stream and directory
 * attribute of the file, the decrypted record tree of each encrypted report stream, and a
 * readable report model (formulas, data source, parameters, layout). jsonToRpt() rebuilds a
 * valid .rpt file from that JSON: unchanged streams are written back byte-identical and edited
 * report streams are re-compressed and re-encrypted.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { isCompoundFile, readCfb } from './cfb/reader.ts';
import { writeCfb, type CfbWriteOptions } from './cfb/writer.ts';
import { documentToJson, jsonToDocument, type FromJsonOptions, type RptJson, type ToJsonOptions } from './json.ts';

export { CfbError } from './cfb/types.ts';
export type { CfbDocument, CfbNode, CfbStorage, CfbStream } from './cfb/types.ts';
export { readCfb, writeCfb, isCompoundFile };
export { buildMetadata, documentToJson, jsonToDocument, FORMAT_ID, FORMAT_VERSION } from './json.ts';
export type { DataEncoding, FromJsonOptions, JsonNode, JsonStorage, JsonStream, RptJson, RptMetadata, ToJsonOptions } from './json.ts';
export type { PropertySetInfo, PropertySection } from './cfb/propertySet.ts';
export type { CatalogEntry, ReportCatalog, StreamHeaderInfo } from './crystal/catalog.ts';
export type { ReportModel } from './json.ts';
export type { AreaInfo, DataSourceInfo, FormulaInfo, ReportDefinition, ReportObject, SectionInfo } from './crystal/model.ts';
export type { JsonDecodedStream, JsonRecord, JsonRecordPart } from './crystal/decodedJson.ts';

export type RptToJsonOptions = Omit<ToJsonOptions, 'sourceBytes'>;
export type JsonToRptOptions = FromJsonOptions & CfbWriteOptions;

/** Parses .rpt bytes into the JSON object model. */
export function rptToJson(bytes: Uint8Array, options: RptToJsonOptions = {}): RptJson {
  return documentToJson(readCfb(bytes), { ...options, sourceBytes: bytes });
}

/** Builds .rpt bytes from the JSON object model (a parsed object or a JSON string). */
export function jsonToRpt(json: RptJson | string, options: JsonToRptOptions = {}): Uint8Array {
  const value: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  return writeCfb(jsonToDocument(value, options), options);
}

export async function rptFileToJson(path: string, options: RptToJsonOptions = {}): Promise<RptJson> {
  return rptToJson(await readFile(path), { fileName: basename(path), ...options });
}

export async function jsonFileToRpt(jsonPath: string, rptPath: string, options: JsonToRptOptions = {}): Promise<void> {
  await writeFile(rptPath, jsonToRpt(await readFile(jsonPath, 'utf8'), options));
}

export { convertDocumentToSsrs, reviewMarkdown, type ConvertedReport, type SsrsOptions } from './ssrs/convert.ts';
export { convertToRdl, type RdlOptions, type RdlResult, type ReviewNote } from './ssrs/rdl.ts';
export { translateFormula, type FormulaContext, type Translation } from './ssrs/formula.ts';
