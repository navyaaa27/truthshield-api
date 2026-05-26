export function explainAnalyze(query) {
  return Promise.resolve({
    plan: "Seq Scan on table",
    executionTime: 0.1
  });
}
