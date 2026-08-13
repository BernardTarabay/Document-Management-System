// Excel extraction (spec §8): workbook metadata, worksheet names, headers,
// table/dimension info. Cell content is sampled, not dumped wholesale --
// full-cell text extraction for search happens via the header/sample text
// captured here, keeping this bounded for very large workbooks.
const ExcelJS = require("exceljs");

const MAX_SAMPLE_ROWS = 20;
const MAX_SAMPLE_COLS = 20;

async function extract(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const worksheets = workbook.worksheets.map((ws) => {
    const headers = [];
    const headerRow = ws.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      if (headers.length < MAX_SAMPLE_COLS) headers.push(String(cell.value ?? "").trim());
    });

    let formulaCount = 0;
    const sampleText = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_SAMPLE_ROWS) return;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.formula) formulaCount += 1;
        const v = cell.value;
        if (v !== null && v !== undefined && typeof v !== "object") sampleText.push(String(v));
      });
    });

    return {
      name: ws.name,
      rowCount: ws.rowCount,
      columnCount: ws.columnCount,
      headers,
      formulaCount,
      sampleText: sampleText.slice(0, 200),
    };
  });

  return {
    extractor: "xlsx",
    extractorVersion: "exceljs",
    metadata: {
      sheetNames: worksheets.map((w) => w.name),
      sheetCount: worksheets.length,
      worksheets: worksheets.map(({ sampleText, ...rest }) => rest), // keep metadata bounded; text goes below
      creator: workbook.creator || null,
      lastModifiedBy: workbook.lastModifiedBy || null,
      created: workbook.created || null,
      modified: workbook.modified || null,
      // docProps/core.xml "Title" -- same field docx/pptx/pdf now surface,
      // feeds namingService's title-first naming.
      title: workbook.title || null,
    },
    text: worksheets
      .map((w) => [w.name, ...w.headers, ...w.sampleText].join(" "))
      .join("\n"),
  };
}

module.exports = { extract };
