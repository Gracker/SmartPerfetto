#!/bin/bash
# SmartPerfetto - 一键合并 Perfetto 上游更新
# 此脚本会自动从官方 perfetto 仓库合并最新代码到你的 fork

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
    echo -e "${BLUE}🔄 SmartPerfetto - 合并 Perfetto 上游更新${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# 检查是否在主项目根目录
check_in_main_repo() {
    if [ ! -f ".gitmodules" ]; then
        print_error "未找到 .gitmodules 文件，请在主项目根目录运行此脚本"
        exit 1
    fi
}

# 检查 perfetto 子模块是否存在
check_perfetto_submodule() {
    if [ ! -d "perfetto" ]; then
        print_error "未找到 perfetto 子模块目录"
        exit 1
    fi

    if [ ! -d "perfetto/.git" ]; then
        print_error "perfetto 不是有效的 git 仓库"
        exit 1
    fi
}

# 检查工作区状态
check_clean_working_tree() {
    local repo_name=$1
    cd "$2"

    if [ -n "$(git status --porcelain)" ]; then
        print_error "$repo_name 有未提交的更改"
        git status --short
        print_error "请先提交或暂存所有更改后再运行此脚本"
        cd - > /dev/null
        exit 1
    fi

    cd - > /dev/null
}

# 获取上游更新数
count_upstream_commits() {
    cd perfetto

    # 获取当前分支与上游的差异
    local count=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")

    cd ..
    echo "$count"
}

# 合并上游更新
merge_upstream() {
    print_info "📥 进入 perfetto 子模块..."
    cd perfetto

    # 确认当前分支
    local current_branch=$(git branch --show-current)
    print_info "当前分支: $current_branch"

    if [ "$current_branch" != "smartperfetto" ]; then
        print_warning "当前不在 smartperfetto 分支上"
        read -p "是否切换到 smartperfetto 分支？(Y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Nn]$ ]]; then
            git checkout smartperfetto
            print_success "已切换到 smartperfetto 分支"
        else
            print_error "操作已取消"
            cd ..
            exit 1
        fi
    fi

    # 检查 fork 远程仓库
    if ! git remote | grep -q "^fork$"; then
        print_error "未找到 fork 远程仓库"
        print_info "添加 fork 远程仓库: git@github.com:Gracker/perfetto.git"
        git remote add fork git@github.com:Gracker/perfetto.git
        print_success "已添加 fork 远程仓库"
    fi

    # 获取上游最新代码
    print_info "📥 获取上游最新代码..."
    git fetch origin main

    # 统计需要合并的提交数
    local commit_count=$(git rev-list --count HEAD..origin/main)
    print_info "需要合并 $commit_count 个上游提交"

    if [ "$commit_count" -eq 0 ]; then
        print_warning "没有新的上游提交需要合并"
        cd ..
        return
    fi

    # 显示最新的上游提交
    print_info "上游最新提交:"
    git log --oneline origin/main -5

    echo ""
    print_warning "即将合并 $commit_count 个上游提交"
    read -p "是否继续？(Y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        print_error "操作已取消"
        cd ..
        exit 1
    fi

    # 合并上游更新
    print_info "🔀 合并上游更新..."
    if git merge origin/main --no-edit; then
        print_success "上游更新合并成功（无冲突）"
    else
        print_error "合并遇到冲突！"
        print_info "请手动解决冲突后继续："
        print_info "1. cd perfetto"
        print_info "2. 查看冲突文件: git status"
        print_info "3. 解决冲突"
        print_info "4. 标记冲突已解决: git add <files>"
        print_info "5. 完成合并: git commit"
        print_info "6. 返回主项目: cd .."
        cd ..
        exit 1
    fi

    # 推送到 fork
    print_info "📤 推送到 fork 仓库..."
    git push fork smartperfetto

    cd ..
    print_success "Perfetto 子模块更新完成"
}

# 更新主项目子模块指针
update_main_submodule_pointer() {
    print_info "📝 更新主项目子模块指针..."

    # 暂存子模块更新
    git add perfetto

    # 检查是否有实际变更
    if git diff --cached --quiet; then
        print_warning "子模块指针没有变化，无需提交"
        return
    fi

    # 获取 perfetto 的最新提交
    cd perfetto
    local perfetto_commit=$(git rev-parse --short HEAD)
    local perfetto_commit_msg=$(git log -1 --pretty=%B HEAD | head -1)
    cd ..

    # 提交子模块更新
    git commit -m "chore: merge upstream perfetto updates

- Perfetto submodule updated to $perfetto_commit
- $perfetto_commit_msg

Run './scripts/sync-perfetto-upstream.sh' to perform this merge."

    print_success "主项目子模块指针已更新"
}

# 主函数
main() {
    print_header

    # 保存当前目录
    local main_dir=$(pwd)

    # 检查环境
    check_in_main_repo
    check_perfetto_submodule

    print_info "📍 当前目录: $main_dir"

    # 检查工作区状态
    print_info "🔍 检查主项目状态..."
    check_clean_working_tree "主项目" "$main_dir"

    print_info "🔍 检查 perfetto 子模块状态..."
    check_clean_working_tree "Perfetto 子模块" "$main_dir/perfetto"

    # 统计上游更新
    local upstream_count=$(count_upstream_commits)
    if [ "$upstream_count" -eq 0 ]; then
        print_warning "没有新的上游提交需要合并"
        exit 0
    fi

    echo ""

    # 合并上游更新
    merge_upstream

    echo ""

    # 更新主项目
    update_main_submodule_pointer

    echo ""
    print_header
    print_success "上游合并完成！"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    print_info "📋 下一步："
    print_info "1. 推送到远程: git push origin main"
    print_info "2. 或者使用一键推送: ./scripts/push-all.sh"
    echo ""
}

# 执行主函数
main
