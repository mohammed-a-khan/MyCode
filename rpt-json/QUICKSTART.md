# rpt-json – Quick start

Converts Crystal Reports `.rpt` files to JSON and back, and generates SSRS `.rdl` reports.
No packages to install: it needs only Node.js.

## 1. Install Node.js

Install **Node.js 22.18 or later** (LTS 22.x or 24.x) from https://nodejs.org. Check it:

```
node --version
```

## 2. Unzip

Unzip `rpt-json.zip` anywhere, for example `C:\tools\rpt-json`, and open a terminal in that folder:

```
cd C:\tools\rpt-json
```

There is no `npm install` step: the tool has no dependencies.

## 3. Convert reports to SSRS

One report:

```
node src/cli.ts to-rdl "C:\reports\Sales.rpt" "C:\out"
```

A whole folder of reports:

```
node src/cli.ts to-rdl "C:\reports" "C:\out"
```

With your SQL Server connection string written into every report:

```
node src/cli.ts to-rdl "C:\reports" "C:\out" --connection "Data Source=SQLPROD01;Initial Catalog=Sales"
```

For each report you get:

| File                              | What it is                                                     |
|-----------------------------------|----------------------------------------------------------------|
| `Sales.rdl`                       | The SSRS report (RDL 2016: SSRS 2016–2022, Power BI Report Server, Report Builder) |
| `Sales_Subdocument_1.rdl`, …      | Only for subreports inside the table (per row); upload them next to the main report. Other subreports are built into `Sales.rdl` |
| `Sales.review.md`                 | Checklist of what a person should check or finish              |

Then open the `.rdl` in Report Builder or Visual Studio (SSRS project), work through `review.md`, and deploy.

Use your server's shared data source instead of a connection string:

```
node src/cli.ts to-rdl "C:\reports" "C:\out" --shared-datasource "MySharedDataSource"
```

To render on the report server: upload the `.rdl` files (main report and its `_Subdocument_N` files) into one
folder, make sure the data source is the shared one (or set its credentials under **Manage → Data sources**), and run
the report. The data source account needs access to the procedures or tables the Crystal report used.

### In your house style

Give an existing SSRS report of your house style (with its page header and footer) as a template. Each Crystal report
keeps its own data, laid out with the template's title row, column headings, detail and totals rows, fonts, colours
and page header/footer:

```
node src/cli.ts to-rdl "C:\reports\Sales.rpt" "C:\out" --template "C:\templates\House.rdl"
```

Several Crystal reports in one SSRS report, one block per report (each on its own page if the template's table has a
page break):

```
node src/cli.ts to-rdl --template "C:\templates\House.rdl" --combine "C:\out\Combined.rdl" "C:\reports\A.rpt" "C:\reports\B.rpt"
```

## 4. Convert to JSON and back

```
node src/cli.ts to-json "C:\reports\Sales.rpt" Sales.json      # .rpt -> JSON
node src/cli.ts to-rpt  Sales.json Sales-rebuilt.rpt           # JSON -> .rpt
node src/cli.ts inspect "C:\reports\Sales.rpt"                 # readable summary only
node src/cli.ts verify  "C:\reports\Sales.rpt"                 # round-trip self-check
```

In the JSON, `metadata.reports[].definition` is the readable report (formulas, parameters, groups, layout) and
`metadata.reports[].dataSource` holds the connection, tables, fields and joins. Edits to the decoded record text are
written back when you run `to-rpt`. Test edited reports in Crystal before using them.

## 5. List header text

The titles and labels in the report and page headers, group headers, the column headings above the detail rows
(left to right) and chart titles, for the report and its subreports:

```
node src/cli.ts headers "C:\reports\Sales.rpt"                          # readable listing
node src/cli.ts headers "C:\reports\Sales.rpt" headers.csv --csv        # CSV for Excel
node src/cli.ts headers "C:\reports" all-headers.csv --csv               # every report in a folder
node src/cli.ts headers "C:\reports\Sales.rpt" --json                   # JSON
node src/cli.ts headers "C:\reports\Sales.rpt" --all                    # also footer and detail text, and fields
```

Embedded database fields appear as `{Table.Field}`. In CSV and JSON, text over several lines keeps its line breaks;
the readable listing shows them as ` / `.

## 6. Run the tests (optional)

```
npm test
```

To also test your own reports (every `.rpt` in the folder must round-trip exactly and convert to valid RDL):

```
set RPT_SAMPLES_DIR=C:\reports          (Windows cmd)
$env:RPT_SAMPLES_DIR="C:\reports"       (PowerShell)
export RPT_SAMPLES_DIR=/path/to/reports (Linux / macOS)
npm test
```

## Using it from code

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { rptToJson, jsonToRpt } from './src/index.ts';

const json = rptToJson(readFileSync('Sales.rpt'));                 // .rpt -> JSON object
console.log(json.metadata?.reports[0].definition?.formulas);      // readable report model
writeFileSync('Sales-rebuilt.rpt', jsonToRpt(json));              // JSON -> .rpt
```

`README.md` has the full documentation: the JSON format, what converts to SSRS and how, and known limits.
