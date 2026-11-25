#!/usr/bin/env bash
# LunaTV → Cloudflare Workers 一键部署
# 依赖：CLOUDFLARE_API_TOKEN（Workers Scripts:Edit + D1:Edit）
# 可选：CF_ACCOUNT_ID / ADMIN_USER / ADMIN_PASS

set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

DB_NAME="moontv"
WORKER_NAME="lunatv"
API="https://api.cloudflare.com/client/v4"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "缺少 CLOUDFLARE_API_TOKEN"

# ---------- 1. 校验 token ----------
log "1/7 校验 API Token"
VERIFY=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify")
echo "$VERIFY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.success){console.error('Token 无效: '+JSON.stringify(j.errors));process.exit(1)}console.log('  token 状态: '+j.result.status)})" || die "Token 校验失败"

# ---------- 2. Account ID ----------
log "2/7 解析 Account ID"
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  ACC=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/accounts")
  CF_ACCOUNT_ID=$(echo "$ACC" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.success||!j.result||!j.result.length){console.error('获取账号失败: '+JSON.stringify(j.errors||j));process.exit(1)}console.log(j.result[0].id)})") || die "无法列出账号，请手动设置 CF_ACCOUNT_ID"
fi
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
ok "Account: $CF_ACCOUNT_ID"

# ---------- 3. 校验 D1 库 ----------
log "3/7 校验 D1 数据库 $DB_NAME"
D1=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/accounts/$CF_ACCOUNT_ID/d1/database?per_page=100")
echo "$D1" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const j=JSON.parse(d);
  if(!j.success){console.error('D1 列表失败: '+JSON.stringify(j.errors));process.exit(1)}
  const hit=j.result.find(x=>x.name==='$DB_NAME');
  if(!hit){console.error('找不到库 $DB_NAME，现有: '+j.result.map(x=>x.name).join(', '));process.exit(1)}
  console.log('  D1 uuid: '+hit.uuid);
  if(hit.uuid!=='ed9fa12d-9fb5-40b5-834b-ae123c3f4f08') console.log('  ⚠ 与 wrangler.toml 里的 id 不一致，请检查');
})" || die "D1 校验失败"
ok "D1 就绪"

# ---------- 4. 建表 ----------
log "4/7 灌入表结构（幂等）"
npx wrangler d1 execute "$DB_NAME" --remote --file=./migrations/0001_init.sql --yes 2>&1 | tail -20
ok "表结构完成"

# ---------- 5. 构建 ----------
log "5/7 安装依赖并构建（3-5 分钟）"
[ -d node_modules ] || pnpm install --no-frozen-lockfile 2>&1 | tail -5
pnpm build:cloudflare 2>&1 | tail -25
[ -f .open-next/worker.js ] || die "构建产物缺失 .open-next/worker.js"
ok "构建产物: $(du -h .open-next/worker.js | cut -f1)"

# ---------- 6. 站长账号 ----------
log "6/7 配置站长账号"
if [ -n "${ADMIN_USER:-}" ] && [ -n "${ADMIN_PASS:-}" ]; then
  printf '%s' "$ADMIN_USER" | npx wrangler secret put USERNAME 2>&1 | tail -3
  printf '%s' "$ADMIN_PASS" | npx wrangler secret put PASSWORD 2>&1 | tail -3
  ok "USERNAME / PASSWORD 已写入 Worker Secret"
else
  printf '  ⚠ 未提供 ADMIN_USER / ADMIN_PASS，跳过后台登录密码设置\n'
fi

# ---------- 7. 部署 ----------
log "7/7 部署 Worker"
npx wrangler deploy 2>&1 | tee /tmp/cf-deploy.log | tail -20

URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' /tmp/cf-deploy.log | head -1 || true)
if [ -n "$URL" ]; then
  log "冒烟测试 $URL"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL/" || echo "000")
  echo "  根路径 HTTP $CODE"
  CODE2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL/api/server-config" || echo "000")
  echo "  /api/server-config HTTP $CODE2"
  [ "$CODE" = "200" ] || [ "$CODE" = "307" ] || echo "  ⚠ 状态码异常，检查 wrangler tail"
fi

printf '\n\033[1;32m部署完成\033[0m\n'
[ -n "$URL" ] && printf '访问地址: %s\n登录账号: 控制台设置的 USERNAME / PASSWORD\n' "$URL"
