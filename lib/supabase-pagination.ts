type PageResult<Row> = {
  data: Row[] | null
  error: unknown
}

export async function loadAllRows<Row>(
  loadPage: (from: number, to: number) => PromiseLike<PageResult<Row>>,
  pageSize = 1000,
) {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error('pageSize must be a positive integer')
  }

  const rows: Row[] = []
  for (let from = 0; ; from += pageSize) {
    const page = await loadPage(from, from + pageSize - 1)
    if (page.error) throw page.error
    const pageRows = page.data || []
    rows.push(...pageRows)
    if (pageRows.length < pageSize) return rows
  }
}
