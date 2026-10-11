#!/bin/bash
# 项目问题扫描脚本

echo "🔍 扫描 Plain Agent 项目问题..."
echo ""

# 1. TypeScript 编译错误
echo "1️⃣ TypeScript 编译检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "📦 Domain:"
cd domain && npx tsc --noEmit 2>&1 | grep "error TS" | head -20
domain_errors=$?

echo ""
echo "📦 CLI:"
cd ../cli && npx tsc --noEmit 2>&1 | grep "error TS" | head -20
cli_errors=$?

echo ""
echo "📦 Desktop:"
cd ../desktop && npx tsc --noEmit 2>&1 | grep "error TS" | head -20
desktop_errors=$?
cd ..

echo ""
echo "2️⃣ ESLint 检查（如果配置了）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f ".eslintrc.json" ] || [ -f ".eslintrc.js" ]; then
    npx eslint --ext .ts,.tsx . 2>&1 | head -20
else
    echo "⏭️  未配置 ESLint"
fi

echo ""
echo "3️⃣ 未使用的依赖检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if command -v depcheck &> /dev/null; then
    depcheck --json | jq '.dependencies, .devDependencies' 2>/dev/null || echo "⏭️  depcheck 未安装"
else
    echo "⏭️  depcheck 未安装（npm install -g depcheck）"
fi

echo ""
echo "4️⃣ 代码复杂度检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "统计代码行数："
find . -name "*.ts" -o -name "*.tsx" | grep -v node_modules | xargs wc -l | tail -1

echo ""
echo "5️⃣ Git 状态检查"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
git status --short

echo ""
echo "6️⃣ 安全漏洞检查（npm audit）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pnpm audit --audit-level=moderate 2>&1 | head -20

echo ""
echo "✅ 扫描完成！"
