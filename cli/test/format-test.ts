/**
 * 测试工具结果格式化
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

function formatResultSummary(tool: string, result: string): string {
  const len = result.length;

  switch (tool) {
    case 'bash':
      if (len === 0) return 'no output';
      const bashLines = result.split('\n').filter(line => line.trim()).length;
      // 单行输出：直接显示内容
      if (bashLines === 1) {
        return truncate(result.trim(), 80);
      }
      // 多行输出：显示统计 + 首行预览
      const firstLine = result.split('\n')[0].trim();
      return `${bashLines} lines${firstLine ? ' · ' + truncate(firstLine, 40) : ''}`;
    default:
      return truncate(result, 100);
  }
}

// 测试用例
const testCases = [
  {
    tool: 'bash',
    result: 'C:\\Program Files\\nodejs\\node.exe',
    expected: 'C:\\Program Files\\nodejs\\node.exe'
  },
  {
    tool: 'bash',
    result: 'v20.11.0',
    expected: 'v20.11.0'
  },
  {
    tool: 'bash',
    result: 'line1\nline2\nline3',
    expected: '3 lines · line1'
  },
  {
    tool: 'bash',
    result: '',
    expected: 'no output'
  },
  {
    tool: 'bash',
    result: 'single line',
    expected: 'single line'
  },
];

console.log('Testing formatResultSummary:\n');
testCases.forEach((test, i) => {
  const actual = formatResultSummary(test.tool, test.result);
  const pass = actual === test.expected;
  console.log(`Test ${i + 1}: ${pass ? '✓' : '✗'}`);
  console.log(`  Input: ${JSON.stringify(test.result)}`);
  console.log(`  Expected: ${test.expected}`);
  console.log(`  Actual: ${actual}`);
  if (!pass) {
    console.log(`  Result length: ${test.result.length}`);
    console.log(`  Lines (all): ${test.result.split('\n').length}`);
    console.log(`  Lines (trimmed): ${test.result.split('\n').filter(line => line.trim()).length}`);
  }
  console.log();
});
