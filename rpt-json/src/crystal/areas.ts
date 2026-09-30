/** Report areas by role: Crystal stores them in a fixed order, and names them unless a designer renamed them. */

import type { AreaInfo, SectionInfo } from './model.ts';

export interface ClassifiedAreas {
  pageHeader: SectionInfo[];
  pageFooter: SectionInfo[];
  reportHeader: SectionInfo[];
  reportFooter: SectionInfo[];
  detail: SectionInfo[];
  /** Group headers and footers by group level (1 = outermost). */
  groupHeaders: Map<number, SectionInfo[]>;
  groupFooters: Map<number, SectionInfo[]>;
  /** Areas with objects whose role could not be determined. */
  unrecognised: AreaInfo[];
}

export function classifyAreas(layout: AreaInfo[], subreport = false): ClassifiedAreas {
  const result: ClassifiedAreas = {
    pageHeader: [], pageFooter: [], reportHeader: [], reportFooter: [], detail: [],
    groupHeaders: new Map(), groupFooters: new Map(), unrecognised: [],
  };
  // Crystal stores areas in a fixed order: page header, page footer, report header, report footer,
  // one group header/footer pair per group (outermost first), details, then an empty end marker.
  // Using the order keeps areas the report designer renamed (e.g. "Area2").
  // A subreport has no page header/footer areas, so its order starts at the report header.
  const real = layout.filter((a) => a.sections.length > 0);
  const fixed = subreport ? 3 : 5;
  const first = fixed - 3;
  const groups = (real.length - fixed) / 2;
  if (real.length >= fixed && Number.isInteger(groups)) {
    if (!subreport) {
      result.pageHeader.push(...real[0].sections);
      result.pageFooter.push(...real[1].sections);
    }
    result.reportHeader.push(...real[first].sections);
    result.reportFooter.push(...real[first + 1].sections);
    for (let i = 0; i < groups; i++) {
      result.groupHeaders.set(i + 1, real[first + 2 + i * 2].sections);
      // Stored as header 1, footer 1, header 2, footer 2, ...: each footer follows its own header.
      result.groupFooters.set(i + 1, real[first + 3 + i * 2].sections);
    }
    result.detail.push(...real[real.length - 1].sections);
    return result;
  }
  let groupHeaderCount = 0;
  let groupFooterCount = 0;
  for (const area of layout) {
    const level = Number(/(\d+)$/.exec(area.name)?.[1] ?? 0);
    if (/^PageHeader/i.test(area.name)) result.pageHeader.push(...area.sections);
    else if (/^PageFooter/i.test(area.name)) result.pageFooter.push(...area.sections);
    else if (/^ReportHeader/i.test(area.name)) result.reportHeader.push(...area.sections);
    else if (/^ReportFooter/i.test(area.name)) result.reportFooter.push(...area.sections);
    else if (/^GroupHeader/i.test(area.name)) result.groupHeaders.set(level || ++groupHeaderCount, area.sections);
    else if (/^GroupFooter/i.test(area.name)) result.groupFooters.set(level || ++groupFooterCount, area.sections);
    else if (/^Detail/i.test(area.name) && area.sections.length > 0) result.detail.push(...area.sections);
    else if (area.sections.some((s) => s.objects.length > 0)) result.unrecognised.push(area);
  }
  return result;
}
