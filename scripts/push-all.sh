#!/bin/bash
# SmartPerfetto - 一键推送两个仓库
# 此脚本会推送主项目和 perfetto 子模块的更新

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的信息
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_header() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}🚀 SmartPerfetto - 一键推送两个仓库${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# 检查是否在主项目根目录
check_in_main_repo() {
    if [ ! -f ".gitmodules" ]; then
        print_error "未找到 .gitmodules 文件，请在主项目根目录运行此脚本"
        exit 1
    fi
}

# 检查工作区状态
check_git_status() {
    local repo_name=$1
    cd "$2"

    if [ -n "$(git status --porcelain)" ]; then
        print_warning "$repo_name 有未提交的更改"
        git status --short
        read -p "是否继续推送？(y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_error "操作已取消"
            exit 1
        fi
    fi

    cd - > /dev/null
}

# 推送主项目
push_main_repo() {
    print_info "📦 推送主项目..."

    # 获取当前分支
    local current_branch=$(git branch --show-current)

    print_info "当前分支: $current_branch"

    # 推送到 origin
    git push origin "$current_branch"

    print_success "主项目推送成功"
}

# 推送 perfetto 子模块
push_perfetto_submodule() {
    print_info "📦 推送 perfetto 子模块..."

    cd perfetto

    # 获取当前分支
    local current_branch=$(git branch --show-current)

    print_info "当前分支: $current_branch"

    # 检查是否有 fork 远程仓库
    if ! git remote | grep -q "^fork$"; then
        print_error "未找到 fork 远程仓库"
        print_info "请先运行: git remote add fork git@github.com:Gracker/perfetto.git"
        cd ..
        exit 1
    fi

    # 推送到 fork
    git push fork "$current_branch"

    cd ..

    print_success "Perfetto 子模块推送成功"
}

# 主函数
main() {
    print_header

    # 保存当前目录
    local main_dir=$(pwd)

    # 检查环境
    check_in_main_repo

    print_info "📍 当前目录: $main_dir"

    # 检查主项目状态
    print_info "🔍 检查主项目状态..."
    check_git_status "主项目" "$main_dir"

    # 检查 perfetto 子模块状态
    if [ -d "perfetto" ]; then
        print_info "🔍 检查 perfetto 子模块状态..."
        check_git_status "Perfetto 子模块" "$main_dir/perfetto"
    else
        print_error "未找到 perfetto 子模块目录"
        exit 1
    fi

    echo ""

    # 推送 perfetto 子模块
    push_perfetto_submodule

    echo ""

    # 推送主项目
    push_main_repo

    echo ""
    print_header
    print_success "所有仓库推送完成！"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# 执行主函数
main
