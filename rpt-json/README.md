# rpt-json

In-house converter between Crystal Reports `.rpt` files and JSON, written in TypeScript with **no third-party
dependencies**. It uses only Node.js built-ins: `fs`, `zlib` for compression, and `crypto` for SHA-256 checksums.
The AES cipher is implemented in this project.

- **`.rpt` → JSON:**
  - every storage, stream and attribute of the file
  - the **decrypted record tree** of each encrypted report stream, with its text readable and editable
  - a readable **report model**: formulas, selection formulas, parameters, data source (connections, tables, typed
    fields), groups, sorts, summaries and layout (areas → sections → objects)
- **JSON → `.rpt`:** rebuilds a valid `.rpt`. Unchanged streams are written back byte-identical. Edited report streams
  are re-compressed and re-encrypted.
- **`.rpt` → SSRS:** generates `.rdl` report definitions for SQL Server Reporting Services (see
  [Converting to SSRS](#converting-to-ssrs)), with a review checklist for each report.

## Requirements

Node.js **22.18 or later** (or 23.6 and later), which runs `.ts` files directly with no build step. On earlier 22.x
and 23.x versions, add `--experimental-strip-types` after `node`.

No packages are installed, not even type definitions: `types/node.d.ts` declares the Node built-ins the code uses, so
editors and `tsc` type-check the project as it is. `npm run build` (with a `tsc` you already have) writes plain
JavaScript to `dist/`; run it with `node dist/src/cli.js`.

## Command line

```bash
node src/cli.ts to-json  report.rpt report.json          # full JSON (original bytes + decoded + model)
node src/cli.ts to-rpt   report.json rebuilt.rpt
node src/cli.ts to-rdl   report.rpt out/                 # SSRS .rdl (+ subreports) and a review checklist
node src/cli.ts to-rdl   reports/ out/                   # every .rpt in a folder
node src/cli.ts to-rdl   report.rpt out/ --template house.rdl              # in the style of an existing report
node src/cli.ts to-rdl   --template house.rdl --combine out/All.rdl a.rpt b.rpt   # several reports in one .rdl
node src/cli.ts headers  report.rpt                      # header text: titles, labels, column headings
node src/cli.ts headers  reports/ headers.csv --csv      # every report in a folder, as CSV (or --json)
node src/cli.ts inspect  report.rpt                      # just the readable model and stream catalog
node src/cli.ts charts   report.rpt                      # how each chart is stored, names hidden (to share safely)
node src/cli.ts layout   report.rpt "Some title" ...       # layout of the subreports showing those texts, names hidden
node src/cli.ts verify   report.rpt                      # round-trip checks (see below)
```

| Option              | Command   | Meaning                                                                        |
|---------------------|-----------|--------------------------------------------------------------------------------|
| `--no-decode`       | `to-json` | Don't decrypt report streams; keep them only as original bytes                   |
| `--no-original`     | `to-json` | Drop the original bytes of decoded streams (smaller JSON; all are re-encrypted) |
| `--no-metadata`     | `to-json` | Omit the informational `metadata` section                                      |
| `--hex`             | `to-json` | Write raw stream bytes as hex instead of base64                                |
| `--compact`         | `to-json` | Single-line JSON                                                               |
| `--no-verify`       | `to-rpt`  | Skip `size`/`sha256` checks on raw `data` (use after hand-editing it)          |
| `--cfb-version 3\|4` | `to-rpt`  | Container version to write (default: same as the source)                       |
| `--connection "..."` | `to-rdl`  | SQL Server connection string to use in every generated report                  |
| `--shared-datasource <name>` | `to-rdl` | Use a shared data source on the report server instead of an embedded connection |
| `--separate-subreports` | `to-rdl` | Write every subreport as its own `.rdl` (by default those outside the table are built into the report) |
| `--page-number` | `to-rdl` | Add "Page N" at the right of the page footer (for reports whose page numbers the printing application added) |
| `--parameter name=value` | `to-rdl` | Convert for that parameter value: sections and objects its suppress formulas hide are left out (they take no space, as in Crystal); repeat for more parameters |
| `--chart-axis-format <format>` | `to-rdl` | Value-axis number format (e.g. `"0.00%"`) for charts whose format the `.rpt` does not show (it is in Crystal's encrypted chart data); charts with value labels use their labels' format |
| `--template <file.rdl>` | `to-rdl` | Lay each report out in the style of an existing SSRS report (see below)     |
| `--combine <out.rdl>` | `to-rdl`  | With `--template`: put every input report into one `.rdl`, one block each     |

`verify` runs two checks on a file:

1. `.rpt` → JSON → `.rpt`, confirming every stream and attribute comes back identical.
2. The same round trip with the original bytes dropped, confirming every encrypted stream still decodes to the same
   content after being re-compressed and re-encrypted.

```bash
for f in reports/*.rpt; do node src/cli.ts verify "$f"; done
```

## Converting to SSRS

`to-rdl` writes one `.rdl` per report and a `<name>.review.md` checklist. Subreports outside the table (report
header/footer, page header/footer) are built into the report, each reading its own dataset, so there is nothing to
deploy alongside it. A subreport inside the table (in a group header or the details) runs once per row; it stays a
separate `<name>_Subdocument_N.rdl` shown through a subreport item. `--separate-subreports` keeps every subreport
separate. The output uses the RDL 2016 schema, so it opens in SSRS 2016, 2017, 2019 and 2022, Power BI Report Server,
and Report Builder.

### Data source

- **Connection:** the SQL Server connection string is built from the server and database stored in the report, whether
  it connected through OLE DB, ODBC or JDBC (`jdbc:sqlserver://host\\instance:port;databaseName=...`). If the report
  used another database, such as Access, a placeholder is written and flagged. A report that signed in with a SQL
  Server login is flagged, since the generated data source uses Windows authentication. Pass `--connection` to set
  the connection string for all reports.
- **Tables and views:** a `SELECT` of the columns the report uses, joined the way the Crystal links are defined. The
  record selection formula becomes a `WHERE` clause with query parameters when it has an exact SQL equivalent;
  otherwise it becomes a dataset filter. Joins keep their type: inner, left outer, right outer or full outer.
- **Named date ranges** (`in LastFullMonth`, `in YearToDate`, …) become date conditions on `GETDATE()` in the
  `WHERE` clause.
- **`Next({Table.Field})`** becomes a `LEAD()` column in the query.
- **Stored procedure:** the dataset calls the procedure (`CommandType` `StoredProcedure`). Crystal's `@parameters`
  become report parameters and query parameters.
- **SQL command:** the command text is used as the query. Crystal command parameters (`{?name}`) become query
  parameters (`@name`) linked to report parameters.
- **SQL expression fields** (`{%name}`): added to the `SELECT` as computed columns.

### Rendering on the report server

1. Upload the `.rdl`, and any `<name>_Subdocument_N.rdl` files written next to it, into the same folder (subreports
   are found by name; a missing one shows "subreport could not be displayed").
2. Data source: either generate with `--shared-datasource <name>` so the reports use your existing shared data source,
   or, after uploading, open the report's **Manage → Data sources** and choose the shared data source or enter
   credentials. Windows integrated security often fails on a server (the "double hop"), so a shared data source or
   stored credentials is usually needed.
3. The account the data source uses needs `EXECUTE` on the stored procedures, or `SELECT` on the tables, the Crystal
   report read.
4. Fonts used by the report must be installed on the report server for PDF export.
5. Run the report, compare it with the Crystal output, and work through `<name>.review.md`.

### House templates

`--template house.rdl` lays each report out in the style of an existing SSRS report instead of copying the Crystal
layout. Use a finished report of your house style, with its page header and footer, as the template.

From the template:

- the data source, page size and margins, page header and footer, and the datasets, images, code and parameters they
  use (a dataset counts as used when the page header/footer, any style or a parameter refers to it);
- the look of its first table, row by row: the title row, the column-heading row, the "no data" row, the detail row
  and the totals row. Each cell's text box is copied, so fonts, colours, borders and style expressions (such as
  colours read from a branding dataset, or alternating row colours) come along. A rectangle around the table, with
  its page break, is copied too.

From each report:

- its dataset: the Crystal report's own query or stored procedure, read through the template's data source;
- the title (the largest text in the report or page header), one column per detail field with its column heading,
  number formats, and grand totals from the summaries in the footers, with the footer's label;
- sorting: the record sorts, after the group fields.

Report parameters with the same name as a template parameter (Crystal `@owner_id` and template `owner_id`) are the
same parameter. The "no data" row shows when the dataset is empty; the template's message gets the report's title in
place of the template's own (`NO SAMPLE LIST DATA ...` becomes `NO ORDERS DATA ...`).

`--combine out.rdl a.rpt b.rpt ...` builds one report with a block per input report, in order, each with its own
dataset, under one page header and footer. Every block always shows; an empty one shows its title, column headings
and "no data" row.

Group headers and footers, subreports, charts and other text are not part of this layout; the review checklist lists
what was left out, and group subtotals become grand totals (also listed).

### Report elements

| Crystal                            | SSRS                                                                          |
|------------------------------------|-------------------------------------------------------------------------------|
| Parameters                         | Report parameters with prompt, type, multi-value and nullable settings        |
| Range parameters                   | Two parameters (`…_Start`, `…_End`), used with `BETWEEN` / `>=` and `<=`       |
| Formulas                           | Calculated dataset fields, inline expressions, or custom code (see below)     |
| Record / group selection           | `WHERE` clause or dataset filter / group filter                               |
| Groups (with header/footer)        | Table row groups with group header/footer rows; a group on a constant formula (Crystal's way to repeat a header) repeats its header on every page |
| Group sort, Top N / Bottom N       | Group sort by the summary with `TopN` / `BottomN` filter                      |
| Top N with an "Others" group       | A rank column in the query (`DENSE_RANK` over the group total); groups past N are labelled with the "Others" name |
| Record sorts                       | Detail sort expressions with their direction                                  |
| Details                            | Table detail row; one column per field position, widths from the objects     |
| Page-header labels over columns    | Table header row, repeated on every page                                      |
| Other page header/footer items     | Page header/footer items at their positions                                   |
| Report header/footer               | Items above/below the table; totals use the whole dataset                    |
| Summaries (Sum of …, Percentage …) | `Sum()`, `Count()`, `Avg()`, `Max()`, `Min()`, `CountDistinct()`, percentages  |
| Running totals                     | `RunningValue()`                                                              |
| Text objects with embedded fields  | One expression with text and fields in their original order                  |
| Fonts                              | Family, size, bold, italic, underline and colour                              |
| Borders and fills                  | Border style, colour and width; background colour                            |
| Lines / boxes                      | Lines / rectangles; lines inside table sections become cell borders          |
| Pictures                           | Embedded images                                                               |
| Cross-tabs                         | Matrices with row and column groups and grand totals                          |
| Charts                             | Charts with the same category, values and titles, and the matching type: bar → column (plain, stacked, percent, 3D), line, area, pie, doughnut, radar, bubble, stock, funnel |
| Subreports                         | Subreport items pointing to the generated subreport `.rdl`; linked fields and same-named parameters become subreport parameters |
| Subreports in page header/footer   | SSRS allows none there, so their content is placed directly in the header/footer, reading their own dataset (first row); shared variables stay shared |
| Free-form sections                 | One row per section holding a rectangle, with every object at its position   |
| Conditional formatting             | Font and background colour, tooltips, hyperlinks, section suppression as `Hidden`, new page before/after |
| Page orientation and paper size    | Page width/height                                                             |
| Special fields                     | `Globals!PageNumber`, `Globals!TotalPages`, `Globals!ExecutionTime`, …         |
| Page margins                       | The report's own margins; 0.25in when it uses the printer defaults            |

### Formula translation

Crystal formulas are parsed and rewritten as SSRS (VB) expressions. This covers fields, parameters, other formulas,
running totals, operators, `if`/`then`/`else`, `select case`, `in [..]` lists, `in x to y` ranges, string subscripts,
aggregates with group scope, conditional-formatting colours and about 60 common functions.

Formulas written in **Crystal Basic syntax** (`Dim x As Number`, `formula = …`, `End If`) become VB functions too:
the statements carry over, Crystal types and functions are mapped, and `formula` becomes the function's result.

Crystal arrays start at 1. Generated arrays keep slot 0 unused, and `Split()` / `Join()` use the helpers
`CrSplit` / `CrJoin`, so indexes and `UBound()` give the same results as in Crystal.

Formulas that need statements become **VB functions in the report's custom code** (`Code.F_Name(...)`). These include
variables (`Local`, `Global`, `Shared`), assignments, `For`, `While` and `Do` loops, `If` blocks and several
statements. Fields, parameters and aggregates are passed to the function as arguments, and `Global`/`Shared`
variables become class-level variables. Crystal **custom functions** (`Function (...)`) become VB functions with
typed parameters, including `Optional` parameters, arrays (`Redim`), range values and `Select` statements. Variable
declarations are placed at the top of each VB function, as Crystal variables are visible in the whole formula.

Types follow Crystal's rules:

- adding a number to a date adds days (`DateAdd`), and subtracting two dates gives days (`DateDiff`). When a custom
  function's result type is only known at run time, the shared helpers `CrAdd` / `CrSubtract` decide.
- an `if` without `else` returns the default of the `then` value's type (`0`, `""` or `False`), as Crystal does.
- `RGB()` and `Color()` with computed arguments build a `#RRGGBB` colour string; `crMonday` … `crSunday` map to
  `FirstDayOfWeek`.

`OnFirstRecord`, `OnLastRecord`, `Previous`, `PreviousIsNull`, `Next` and `GroupName` are translated too. Anything
that still can't be translated is listed in the review checklist rather than guessed.

### What the review checklist covers

Each item names the report object and says what to check. Typical items:

- a placeholder connection string
- chart types SSRS lacks (3D surface, gauge, histogram, ...), which become column charts
- the `ORDER BY` of `LEAD()` columns made for `Next()`
- custom code to review

No converter makes Crystal → SSRS fully automatic. The goal is a working report plus a short, specific list of what a
person needs to finish.

## Editing a report through JSON

1. `to-json` the report.
2. Edit the `decoded` records of the stream you want to change. For example, find a formula's text in
   `Contents → decoded → records` and change it. String lengths and record lengths are recalculated automatically.
3. `to-rpt` the JSON. Only the streams you changed are re-encrypted; everything else is copied unchanged.

Note that `metadata` is a read-only view that is regenerated on every conversion. Edits to it are ignored; edit
`decoded` instead.

Edit a stream's `decoded` records or its raw `data`, not both: if `data` was changed (its `sha256` no longer
matches) and `decoded` differs from it too, `to-rpt` stops and asks which one to keep instead of losing an edit.

## JSON format

```jsonc
{
  "format": "crystal-rpt-json",
  "formatVersion": 1,
  "source": { "fileName": "report.rpt", "size": 47616, "sha256": "..." },
  "container": { "majorVersion": 3, "minorVersion": 62 },
  "metadata": {                                   // read-only, regenerated from the streams
    "summaryInformation": { ... },                // title, author, dates, application
    "catalog": { "subreports": [...], "embeddedObjects": [...], "entries": [...] },
    "reports": [
      { "storage": "",                            // "" = main report, "Subdocument 1" = a subreport
        "definition": {
          "formulas": [{ "name": "Discounted Price", "kind": "formula",
                         "text": "{Product.Price (SRP)} * 0.75", "referencedFields": ["Product.Price (SRP)"] }],
          "selectionFormulas": { "record": "{Orders.Order Date} = {?Date Range}" },
          "parameters": [{ "name": "Date Range", "prompt": "Enter Date Range:", "valueType": "date" }],
          "sqlExpressions": [], "groups": ["Customer.Region"], "sortFields": [], "summarizedFields": [],
          "layout": [{ "name": "DetailArea1", "sections": [{ "name": "DetailSection1", "objects": [
            { "kind": "field", "name": "ProductName1", "field": "Product.Product Name",
              "position": { "x": 240, "y": 0 }, "font": "Arial" } ] }] }],
          "saveInfo": { "Build Version": "12.0.0.683" }, "locale": "en_US" },
        "dataSource": {
          "connections": [{ "driverLibrary": "crdb_dao.dll", "driver": "Access/Excel (DAO)", "database": "sample.mdb" }],
          "tables": [{ "alias": "Product", "name": "Product",
                       "fields": [{ "name": "Product ID", "type": "integer", "length": 4 }] }],
          "tableLinks": 0 } }
    ]
  },
  "root": {                                       // source of truth for to-rpt
    "type": "storage", "name": "Root Entry",
    "children": [
      { "type": "stream", "name": "Contents", "size": 2802, "sha256": "...",
        "encoding": "base64", "data": "...",       // original bytes (reused when decoded is unchanged)
        "decoded": {
          "kind": "contents", "header": "fc00ffff...", "encrypted": true,
          "records": [
            { "type": "0x0077", "schema": "0x0700", "flags": "0xf8", "content": [
              { "hex": "00000000" },
              { "type": "0x0076", "name": "formula", "schema": "0x0700", "flags": "0xf8", "content": [
                { "type": "0x0071", "name": "namedValue", "schema": "0x0700", "flags": "0xf8",
                  "content": [{ "text": "Discounted Price" }, { "hex": "070008" }, ...] },
                { "hex": "0001" }, { "text": "Product.Price (SRP)" }, { "hex": "020000" },
                { "text": "{Product.Price (SRP)} * 0.75" }, ... ] } ] } ] } },
      { "type": "stream", "name": "ReportInfo", "size": 58, "sha256": "...", "encoding": "base64", "data": "..." }
    ]
  }
}
```

### Records

- `type`, `schema` and `flags` are the record header. `name` is an informational label for record types identified
  so far.
- `content` is the record's own bytes in file order: `{ "text": ... }` for strings, `{ "hex": ... }` for binary data,
  and nested records.
- The layout conversion is exact in both directions. Whatever is shown as text, hex or a nested record, converting
  back reproduces the original bytes.

### Streams

- **Decoded:** `Contents` (the main report and each subreport), `QESession` (the data source), `PromptManager`
  (parameter definitions as XML documents) and `ReportParametersStream` (saved parameter values).
- **Kept as original bytes:** all other streams, such as saved data, charts and embedded images.

## How the file is structured

1. **Compound File container** (Microsoft MS-CFB). The reader and writer are in `src/cfb/`.
2. **Summary properties** (Microsoft MS-OLEPS). The property-set decoder is in `src/cfb/propertySet.ts`.
3. **Encrypted report streams.** These use AES-128 in CFB mode with two fixed engine keys, then zlib compression. The
   code is in `src/crystal/crypto.ts` and `src/crystal/streams.ts`.
4. **Records.** Each record has a type, schema, flags, a big-endian length and XOR-masked content. The code is in
   `src/crystal/records.ts`.
5. **Report model.** Formulas, data source and layout, taken from the record types identified so far. The code is in
   `src/crystal/model.ts`.

## Limits

- **Record meanings are only partly mapped.** The report model covers the record types identified by analysing
  sample reports. Everything else is still available in the record tree, just unlabelled.
- **Chart details beyond the type aren't decoded.** The chart type, values and titles come from the report
  definition. Colours, axis scales and other chart settings are in the `CHART` streams, which are encrypted by the
  charting engine with a key other than the report's. Bar, pie and doughnut types are confirmed against sample
  reports; the other families follow Crystal's documented type numbering, and the review checklist asks to check
  them.
- **Edited reports haven't been opened in Crystal.** The tool can't check that the Crystal designer accepts an edited
  report, so test edited reports in Crystal before relying on them. Unedited round trips keep every stream
  byte-identical.
- **Saved data isn't updated.** If a report was saved with data, the cached rows are not refreshed when you edit the
  definition.
- **Output hasn't been deployed to SSRS.** The generated RDL follows Microsoft's RDL 2016 structure: element nesting
  and ordering match Microsoft's own sample reports wherever those samples use the same elements, and all sample
  conversions are well-formed. It hasn't been deployed to an SSRS server. SQL Server connections, stored procedures,
  SQL commands and outer joins are checked against the sample reports that use them.

## Tests

```bash
npm test                                         # unit tests
RPT_SAMPLES_DIR=/path/to/reports npm test        # also checks every .rpt in that folder
```

The tests cover:

- the AES implementation, against the FIPS-197 test vector and an independent AES
- CFB encryption and decryption
- record parsing and serialization, including random data
- string tokenization
- report-model extraction
- encrypted stream decoding and encoding
- JSON editing round trips
- the container layer: version 3 and 4 files, DIFAT, the mini stream and red-black directory trees
- formula translation to SSRS expressions and to custom code (loops, variables, custom functions, `Select`
  statements, date arithmetic, run-time colours, 1-based arrays), including Crystal Basic syntax
- selection formulas to SQL `WHERE` clauses, and range and multi-value parameters
- RDL generation:
  - data access: inner and outer joins, stored procedures, SQL commands, named date ranges and `Next()`
  - layout: groups, Top N, page headers, lines, boxes, pictures, colours and suppression
  - data regions: matrices, charts (with their Crystal chart type) and running totals
  - page margins, subreport areas and table names containing dots
