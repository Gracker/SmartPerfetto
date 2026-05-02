use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryRow {
    id: i64,
    parent_id: Option<i64>,
    name: String,
    mapping_name: Option<String>,
    self_count: u64,
    cumulative_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzerInput {
    rows: Vec<SummaryRow>,
    sample_count: Option<u64>,
    source_table: Option<String>,
    warnings: Option<Vec<String>>,
    truncated: Option<bool>,
    max_nodes: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FlamegraphNode {
    id: String,
    name: String,
    value: u64,
    self_value: u64,
    depth: usize,
    mapping_name: Option<String>,
    children: Vec<FlamegraphNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionStat {
    name: String,
    mapping_name: Option<String>,
    sample_count: u64,
    self_count: u64,
    percentage: f64,
    self_percentage: f64,
    cumulative_percentage: f64,
    category: String,
    category_label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotPath {
    frames: Vec<String>,
    compressed_frames: Vec<String>,
    sample_count: u64,
    percentage: f64,
    leaf_category: String,
    leaf_category_label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategoryStat {
    category: String,
    label: String,
    sample_count: u64,
    self_count: u64,
    percentage: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadStat {
    utid: Option<u64>,
    thread_name: String,
    process_name: String,
    sample_count: u64,
    percentage: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzerInfo {
    engine: String,
    command: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceInfo {
    sample_table: String,
    has_thread_info: bool,
    filters_applied: Vec<String>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Analysis {
    available: bool,
    sample_count: u64,
    filtered_sample_count: u64,
    root: FlamegraphNode,
    top_functions: Vec<FunctionStat>,
    top_cumulative_functions: Vec<FunctionStat>,
    hot_paths: Vec<HotPath>,
    category_breakdown: Vec<CategoryStat>,
    thread_breakdown: Vec<ThreadStat>,
    warnings: Vec<String>,
    analyzer: AnalyzerInfo,
    source: SourceInfo,
}

fn normalize_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "[unknown]".to_string()
    } else {
        trimmed.to_string()
    }
}

fn pct(value: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    ((value as f64 * 10_000.0 / total as f64).round()) / 100.0
}

fn category_label(category: &str) -> &'static str {
    match category {
        "app" => "业务代码",
        "android-framework" => "Android Framework",
        "art-runtime" => "ART/JIT 运行时",
        "graphics-rendering" => "图形渲染",
        "native" => "Native 库",
        "kernel" => "Kernel",
        _ => "未知符号",
    }
}

fn classify_frame(name: &str, mapping_name: Option<&String>) -> &'static str {
    let frame = normalize_name(name);
    let lower_name = frame.to_lowercase();
    let lower_mapping = mapping_name
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    let combined = format!("{lower_name} {lower_mapping}");

    if lower_name == "[unknown]" || lower_name == "unknown" {
        return "unknown";
    }
    if combined.contains("libhwui")
        || combined.contains("skia")
        || combined.contains("surfaceflinger")
        || combined.contains("renderthread")
        || combined.contains("vulkan")
        || combined.contains("opengl")
        || combined.contains("egl")
    {
        return "graphics-rendering";
    }
    if combined.contains("kernel")
        || lower_mapping.contains("kallsyms")
        || lower_name.starts_with("sys_")
        || lower_name.starts_with("__schedule")
        || lower_name.starts_with("do_syscall")
        || lower_name.starts_with("futex_")
        || lower_name.starts_with("binder_")
    {
        return "kernel";
    }
    if combined.contains("libart")
        || combined.contains("libdexfile")
        || combined.contains("dalvik")
        || combined.contains(".oat")
        || combined.contains(".vdex")
        || lower_name.starts_with("art::")
    {
        return "art-runtime";
    }
    if lower_name.starts_with("android.")
        || lower_name.starts_with("androidx.")
        || lower_name.starts_with("com.android.")
        || lower_mapping.contains("framework.jar")
        || lower_mapping.contains("services.jar")
        || lower_mapping.contains("framework-res")
    {
        return "android-framework";
    }
    if lower_mapping.ends_with(".apk")
        || lower_mapping.contains("/base.apk")
        || lower_mapping.contains("split_config")
        || lower_mapping.contains(".apk!")
        || ((lower_name.starts_with("com.")
            || lower_name.starts_with("org.")
            || lower_name.starts_with("io.")
            || lower_name.starts_with("net."))
            && !lower_name.starts_with("com.android."))
    {
        return "app";
    }
    if lower_mapping.ends_with(".so")
        || lower_mapping.contains(".so")
        || lower_name.contains(".so!")
    {
        return "native";
    }

    "unknown"
}

fn compress_frames(frames: &[String]) -> Vec<String> {
    if frames.len() <= 10 {
        return frames.to_vec();
    }

    let mut compressed = Vec::new();
    compressed.extend_from_slice(&frames[..2]);
    compressed.push("...".to_string());

    let middle_start = 2;
    let middle_end = frames.len().saturating_sub(4);
    let mut interesting: Vec<String> = frames[middle_start..middle_end]
        .iter()
        .filter(|frame| {
            let category = classify_frame(frame, None);
            category == "app" || category == "android-framework" || category == "graphics-rendering"
        })
        .cloned()
        .collect();
    if interesting.len() > 2 {
        interesting = interesting[interesting.len() - 2..].to_vec();
    }
    compressed.extend(interesting);
    compressed.push("...".to_string());
    compressed.extend_from_slice(&frames[frames.len() - 4..]);

    compressed.into_iter().fold(Vec::new(), |mut acc, frame| {
        if !(frame == "..." && acc.last().map(|last| last == "...").unwrap_or(false)) {
            acc.push(frame);
        }
        acc
    })
}

fn build_function_stat(row: &SummaryRow, sample_count: u64) -> FunctionStat {
    let category = classify_frame(&row.name, row.mapping_name.as_ref()).to_string();
    let self_percentage = pct(row.self_count, sample_count);
    let cumulative_percentage = pct(row.cumulative_count, sample_count);
    FunctionStat {
        name: normalize_name(&row.name),
        mapping_name: row.mapping_name.clone(),
        sample_count: row.cumulative_count,
        self_count: row.self_count,
        percentage: if self_percentage > 0.0 {
            self_percentage
        } else {
            cumulative_percentage
        },
        self_percentage,
        cumulative_percentage,
        category_label: category_label(&category).to_string(),
        category,
    }
}

fn build_category_breakdown(
    rows_by_id: &HashMap<i64, SummaryRow>,
    sample_count: u64,
) -> Vec<CategoryStat> {
    let mut by_category: HashMap<String, (u64, u64)> = HashMap::new();
    for row in rows_by_id.values() {
        let category = classify_frame(&row.name, row.mapping_name.as_ref()).to_string();
        let entry = by_category.entry(category).or_insert((0, 0));
        entry.0 += row.cumulative_count;
        entry.1 += row.self_count;
    }

    let mut stats: Vec<CategoryStat> = by_category
        .into_iter()
        .map(
            |(category, (sample_count_for_category, self_count))| CategoryStat {
                label: category_label(&category).to_string(),
                category,
                sample_count: sample_count_for_category,
                self_count,
                percentage: pct(self_count, sample_count),
            },
        )
        .collect();
    stats.sort_by(|left, right| {
        right
            .self_count
            .cmp(&left.self_count)
            .then_with(|| right.sample_count.cmp(&left.sample_count))
            .then_with(|| left.label.cmp(&right.label))
    });
    stats
}

fn build_path(row: &SummaryRow, rows_by_id: &HashMap<i64, SummaryRow>) -> Vec<String> {
    let mut frames = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(row);

    while let Some(frame) = current {
        if !seen.insert(frame.id) {
            break;
        }
        frames.push(normalize_name(&frame.name));
        current = frame
            .parent_id
            .and_then(|parent_id| rows_by_id.get(&parent_id));
    }

    frames.reverse();
    frames
}

fn build_node(
    id: i64,
    depth: usize,
    rows_by_id: &HashMap<i64, SummaryRow>,
    children_by_parent: &HashMap<i64, Vec<i64>>,
    stack: &mut HashSet<i64>,
) -> Option<FlamegraphNode> {
    if !stack.insert(id) {
        return None;
    }

    let row = rows_by_id.get(&id)?;
    let mut child_ids = children_by_parent.get(&id).cloned().unwrap_or_default();
    child_ids.sort_by(|left, right| {
        let left_row = rows_by_id.get(left);
        let right_row = rows_by_id.get(right);
        let left_value = left_row.map(|row| row.cumulative_count).unwrap_or_default();
        let right_value = right_row
            .map(|row| row.cumulative_count)
            .unwrap_or_default();
        right_value.cmp(&left_value).then_with(|| {
            let left_name = left_row.map(|row| row.name.as_str()).unwrap_or_default();
            let right_name = right_row.map(|row| row.name.as_str()).unwrap_or_default();
            left_name.cmp(right_name)
        })
    });

    let children = child_ids
        .into_iter()
        .filter_map(|child_id| {
            build_node(child_id, depth + 1, rows_by_id, children_by_parent, stack)
        })
        .collect();

    stack.remove(&id);
    Some(FlamegraphNode {
        id: id.to_string(),
        name: normalize_name(&row.name),
        value: row.cumulative_count,
        self_value: row.self_count,
        depth,
        mapping_name: row.mapping_name.clone(),
        children,
    })
}

fn build_analysis(input: AnalyzerInput) -> Analysis {
    let mut warnings = input.warnings.unwrap_or_default();
    let source_table = input
        .source_table
        .unwrap_or_else(|| "perfetto_summary_tree".to_string());
    let truncated = input.truncated.unwrap_or(false);
    let max_nodes = input.max_nodes.unwrap_or(0);

    let mut rows_by_id = HashMap::new();
    for row in input.rows {
        rows_by_id.entry(row.id).or_insert(row);
    }

    let inferred_sample_count: u64 = rows_by_id.values().map(|row| row.self_count).sum();
    let sample_count = input.sample_count.unwrap_or(inferred_sample_count);

    let mut root_ids = Vec::new();
    let mut children_by_parent: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in rows_by_id.values() {
        if let Some(parent_id) = row.parent_id {
            if rows_by_id.contains_key(&parent_id) {
                children_by_parent
                    .entry(parent_id)
                    .or_default()
                    .push(row.id);
            } else {
                root_ids.push(row.id);
            }
        } else {
            root_ids.push(row.id);
        }
    }

    root_ids.sort_by(|left, right| {
        let left_row = rows_by_id.get(left);
        let right_row = rows_by_id.get(right);
        let left_value = left_row.map(|row| row.cumulative_count).unwrap_or_default();
        let right_value = right_row
            .map(|row| row.cumulative_count)
            .unwrap_or_default();
        right_value.cmp(&left_value).then_with(|| {
            let left_name = left_row.map(|row| row.name.as_str()).unwrap_or_default();
            let right_name = right_row.map(|row| row.name.as_str()).unwrap_or_default();
            left_name.cmp(right_name)
        })
    });

    let mut stack = HashSet::new();
    let children: Vec<FlamegraphNode> = root_ids
        .into_iter()
        .filter_map(|id| build_node(id, 1, &rows_by_id, &children_by_parent, &mut stack))
        .collect();
    let root_value = if sample_count > 0 {
        sample_count
    } else {
        children.iter().map(|child| child.value).sum()
    };

    let root = FlamegraphNode {
        id: "root".to_string(),
        name: "全部采样".to_string(),
        value: root_value,
        self_value: 0,
        depth: 0,
        mapping_name: None,
        children,
    };

    let function_stats: Vec<FunctionStat> = rows_by_id
        .values()
        .map(|row| build_function_stat(row, sample_count))
        .collect();

    let mut top_functions = function_stats.clone();
    top_functions.sort_by(|left, right| {
        right
            .self_count
            .cmp(&left.self_count)
            .then_with(|| right.sample_count.cmp(&left.sample_count))
            .then_with(|| left.name.cmp(&right.name))
    });
    top_functions.truncate(30);

    let mut top_cumulative_functions = function_stats;
    top_cumulative_functions.sort_by(|left, right| {
        right
            .sample_count
            .cmp(&left.sample_count)
            .then_with(|| right.self_count.cmp(&left.self_count))
            .then_with(|| left.name.cmp(&right.name))
    });
    top_cumulative_functions.truncate(30);

    let mut hot_paths: Vec<HotPath> = rows_by_id
        .values()
        .filter(|row| row.self_count > 0)
        .map(|row| {
            let frames = build_path(row, &rows_by_id);
            let leaf_category = classify_frame(&row.name, row.mapping_name.as_ref()).to_string();
            HotPath {
                compressed_frames: compress_frames(&frames),
                frames,
                sample_count: row.self_count,
                percentage: pct(row.self_count, sample_count),
                leaf_category_label: category_label(&leaf_category).to_string(),
                leaf_category,
            }
        })
        .collect();
    hot_paths.sort_by(|left, right| right.sample_count.cmp(&left.sample_count));
    hot_paths.truncate(20);

    let category_breakdown = build_category_breakdown(&rows_by_id, sample_count);

    if rows_by_id.is_empty() {
        warnings.push("Perfetto 没有产出 CPU 调用栈 summary tree，火焰图为空。".to_string());
    }
    if truncated {
        let limit = if max_nodes == 0 {
            "上限".to_string()
        } else {
            max_nodes.to_string()
        };
        warnings.push(format!(
            "Perfetto summary tree 节点超过 {}，已按累计采样数截断。",
            limit
        ));
    }

    Analysis {
        available: root.value > 0 && !root.children.is_empty(),
        sample_count,
        filtered_sample_count: sample_count,
        root,
        top_functions,
        top_cumulative_functions,
        hot_paths,
        category_breakdown,
        thread_breakdown: Vec::new(),
        warnings,
        analyzer: AnalyzerInfo {
            engine: "rust".to_string(),
            command: None,
        },
        source: SourceInfo {
            sample_table: source_table,
            has_thread_info: false,
            filters_applied: Vec::new(),
            truncated,
        },
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: AnalyzerInput = serde_json::from_str(&input)?;
    let analysis = build_analysis(request);
    println!("{}", serde_json::to_string(&analysis)?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        id: i64,
        parent_id: Option<i64>,
        name: &str,
        mapping_name: Option<&str>,
        self_count: u64,
        cumulative_count: u64,
    ) -> SummaryRow {
        SummaryRow {
            id,
            parent_id,
            name: name.to_string(),
            mapping_name: mapping_name.map(|value| value.to_string()),
            self_count,
            cumulative_count,
        }
    }

    fn analyze(rows: Vec<SummaryRow>, sample_count: u64) -> Analysis {
        build_analysis(AnalyzerInput {
            rows,
            sample_count: Some(sample_count),
            source_table: Some("linux_perf_samples_summary_tree".to_string()),
            warnings: None,
            truncated: Some(false),
            max_nodes: Some(3000),
        })
    }

    #[test]
    fn accepts_camel_case_json_and_emits_camel_case_analysis() {
        let input: AnalyzerInput = serde_json::from_str(
            r#"{
                "rows": [
                    {
                        "id": 1,
                        "parentId": null,
                        "name": "com.demo.MainActivity.onCreate",
                        "mappingName": "base.apk",
                        "selfCount": 5,
                        "cumulativeCount": 5
                    }
                ],
                "sampleCount": 5,
                "sourceTable": "appleos_instruments_samples_summary_tree",
                "warnings": ["已有 warning"],
                "truncated": true,
                "maxNodes": 1
            }"#,
        )
        .expect("input JSON should match the Node-to-Rust contract");

        let analysis = build_analysis(input);
        let output = serde_json::to_value(&analysis).expect("analysis should serialize");

        assert_eq!(output["available"], true);
        assert_eq!(output["sampleCount"], 5);
        assert_eq!(output["filteredSampleCount"], 5);
        assert_eq!(
            output["topFunctions"][0]["name"],
            "com.demo.MainActivity.onCreate"
        );
        assert_eq!(output["topFunctions"][0]["category"], "app");
        assert_eq!(
            output["source"]["sampleTable"],
            "appleos_instruments_samples_summary_tree"
        );
        assert_eq!(output["source"]["truncated"], true);
        assert!(analysis
            .warnings
            .iter()
            .any(|warning| warning == "已有 warning"));
        assert!(analysis
            .warnings
            .iter()
            .any(|warning| warning.contains("已按累计采样数截断")));
    }

    #[test]
    fn ranks_self_and_cumulative_hotspots_with_categories() {
        let analysis = analyze(
            vec![
                row(
                    1,
                    None,
                    "android.os.Looper.loopOnce",
                    Some("framework.jar"),
                    0,
                    20,
                ),
                row(
                    2,
                    Some(1),
                    "com.demo.HomeScreen.render",
                    Some("base.apk"),
                    0,
                    15,
                ),
                row(
                    3,
                    Some(2),
                    "com.demo.ImageDecoder.decode",
                    Some("base.apk"),
                    9,
                    9,
                ),
                row(4, Some(2), "libhwui.so!DrawFrame", Some("libhwui.so"), 6, 6),
                row(5, Some(1), "art::JitCompile", Some("libart.so"), 5, 5),
            ],
            20,
        );

        assert!(analysis.available);
        assert_eq!(analysis.sample_count, 20);
        assert_eq!(
            analysis.source.sample_table,
            "linux_perf_samples_summary_tree"
        );

        let self_hotspot = &analysis.top_functions[0];
        assert_eq!(self_hotspot.name, "com.demo.ImageDecoder.decode");
        assert_eq!(self_hotspot.self_count, 9);
        assert_eq!(self_hotspot.category, "app");
        assert_eq!(self_hotspot.category_label, "业务代码");
        assert_eq!(self_hotspot.self_percentage, 45.0);

        let cumulative_hotspot = &analysis.top_cumulative_functions[0];
        assert_eq!(cumulative_hotspot.name, "android.os.Looper.loopOnce");
        assert_eq!(cumulative_hotspot.sample_count, 20);
        assert_eq!(cumulative_hotspot.category, "android-framework");
        assert_eq!(cumulative_hotspot.cumulative_percentage, 100.0);

        let top_category = &analysis.category_breakdown[0];
        assert_eq!(top_category.category, "app");
        assert_eq!(top_category.self_count, 9);
        assert_eq!(top_category.percentage, 45.0);

        let hot_path = &analysis.hot_paths[0];
        assert_eq!(
            hot_path.frames,
            vec![
                "android.os.Looper.loopOnce",
                "com.demo.HomeScreen.render",
                "com.demo.ImageDecoder.decode"
            ]
        );
        assert_eq!(hot_path.compressed_frames, hot_path.frames);
        assert_eq!(hot_path.leaf_category, "app");
    }

    #[test]
    fn reports_empty_summary_tree_as_unavailable() {
        let analysis = build_analysis(AnalyzerInput {
            rows: Vec::new(),
            sample_count: None,
            source_table: Some("linux_perf_samples_summary_tree".to_string()),
            warnings: Some(vec![
                "Perfetto module loaded but table is empty.".to_string()
            ]),
            truncated: Some(false),
            max_nodes: Some(3000),
        });

        assert!(!analysis.available);
        assert_eq!(analysis.sample_count, 0);
        assert_eq!(analysis.filtered_sample_count, 0);
        assert!(analysis.root.children.is_empty());
        assert!(analysis.top_functions.is_empty());
        assert!(analysis.hot_paths.is_empty());
        assert!(analysis
            .warnings
            .iter()
            .any(|warning| warning.contains("Perfetto module loaded but table is empty.")));
        assert!(analysis
            .warnings
            .iter()
            .any(|warning| warning.contains("火焰图为空")));
    }

    #[test]
    fn classifies_common_android_cpu_frame_sources() {
        let framework_jar = "framework.jar".to_string();
        let base_apk = "base.apk".to_string();
        let libart = "libart.so".to_string();
        let libhwui = "libhwui.so".to_string();
        let libc = "libc.so".to_string();
        let kallsyms = "kallsyms".to_string();

        assert_eq!(
            classify_frame("android.view.Choreographer.doFrame", Some(&framework_jar)),
            "android-framework"
        );
        assert_eq!(
            classify_frame("com.demo.Repository.load", Some(&base_apk)),
            "app"
        );
        assert_eq!(
            classify_frame("art::JitCompile", Some(&libart)),
            "art-runtime"
        );
        assert_eq!(
            classify_frame("libhwui.so!DrawFrame", Some(&libhwui)),
            "graphics-rendering"
        );
        assert_eq!(classify_frame("memcpy", Some(&libc)), "native");
        assert_eq!(classify_frame("__schedule", Some(&kallsyms)), "kernel");
        assert_eq!(classify_frame("", None), "unknown");
    }

    #[test]
    fn compresses_long_hot_paths_without_losing_leaf_context() {
        let analysis = analyze(
            vec![
                row(
                    1,
                    None,
                    "android.os.Looper.loopOnce",
                    Some("framework.jar"),
                    0,
                    12,
                ),
                row(
                    2,
                    Some(1),
                    "android.view.Choreographer.doFrame",
                    Some("framework.jar"),
                    0,
                    12,
                ),
                row(3, Some(2), "com.demo.Screen.draw", Some("base.apk"), 0, 12),
                row(
                    4,
                    Some(3),
                    "android.graphics.RenderNode.draw",
                    Some("framework.jar"),
                    0,
                    12,
                ),
                row(
                    5,
                    Some(4),
                    "com.demo.Renderer.prepare",
                    Some("base.apk"),
                    0,
                    12,
                ),
                row(
                    6,
                    Some(5),
                    "libhwui.so!DrawFrame",
                    Some("libhwui.so"),
                    0,
                    12,
                ),
                row(7, Some(6), "mystery.frame.A", None, 0, 12),
                row(8, Some(7), "mystery.frame.B", None, 0, 12),
                row(9, Some(8), "mystery.frame.C", None, 0, 12),
                row(10, Some(9), "mystery.frame.D", None, 0, 12),
                row(
                    11,
                    Some(10),
                    "com.demo.Bitmap.decode",
                    Some("base.apk"),
                    0,
                    12,
                ),
                row(
                    12,
                    Some(11),
                    "com.demo.Bitmap.loop",
                    Some("base.apk"),
                    12,
                    12,
                ),
            ],
            12,
        );

        let hot_path = &analysis.hot_paths[0];
        assert_eq!(hot_path.frames.len(), 12);
        assert_eq!(
            hot_path.compressed_frames,
            vec![
                "android.os.Looper.loopOnce",
                "android.view.Choreographer.doFrame",
                "...",
                "com.demo.Renderer.prepare",
                "libhwui.so!DrawFrame",
                "...",
                "mystery.frame.C",
                "mystery.frame.D",
                "com.demo.Bitmap.decode",
                "com.demo.Bitmap.loop",
            ]
        );
        assert_eq!(hot_path.leaf_category, "app");
        assert_eq!(hot_path.leaf_category_label, "业务代码");
    }
}
