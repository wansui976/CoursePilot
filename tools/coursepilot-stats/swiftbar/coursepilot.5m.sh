#!/bin/bash
# <bitbar.title>CoursePilot Stats</bitbar.title>
# <bitbar.version>1.0</bitbar.version>
# <bitbar.author>wansui976</bitbar.author>
# <bitbar.desc>在菜单栏显示 wansui976/CoursePilot 的 star 与下载量</bitbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.refreshTime>5m</swiftbar.refreshTime>

REPO="wansui976/CoursePilot"
API="https://api.github.com/repos/$REPO"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

info=$(curl -s -m 20 -H "Accept: application/vnd.github+json" "${AUTH[@]}" "$API")
releases=$(curl -s -m 20 -H "Accept: application/vnd.github+json" "${AUTH[@]}" "$API/releases?per_page=100")

stars=$(printf '%s' "$info" | jq -r '.stargazers_count // empty')
downloads=$(printf '%s' "$releases" | jq -r '[.[] | select(.draft == false) | .assets[].download_count] | add // 0')
latest=$(printf '%s' "$releases" | jq -r '[.[] | select(.draft == false)][0].tag_name // "-"')

if [ -z "$stars" ]; then
  echo "★ 获取失败 | color=#E5484D"
  echo "---"
  echo "打开仓库 | href=https://github.com/$REPO"
  echo "重试 | refresh=true"
  exit 0
fi

echo "★ $stars  ↓ $downloads"
echo "---"
echo "CoursePilot | size=11 color=#8E8E93"
echo "收藏 $stars | sfimage=star.fill"
echo "下载 $downloads | sfimage=arrow.down.circle"
echo "最新版本 $latest | sfimage=tag"
echo "---"
echo "打开仓库 | href=https://github.com/$REPO"
echo "下载页 | href=https://github.com/$REPO/releases"
echo "刷新 | refresh=true"
