#!/usr/bin/env python3
"""
Regenerate perfettoSqlIndex.light.json and perfettoSqlIndex.json from the
Perfetto SQL source.

Extracts CREATE PERFETTO FUNCTION/TABLE/VIEW declarations with their
documentation comments. Produces a compact index used by the
sqlKnowledgeBase for Claude's lookup_sql_schema tool, plus a full index with
SQL source content for packaged full-SQL fallback paths.

Usage:
    python3 scripts/regenerate-sql-index.py

Output:
    data/perfettoSqlIndex.light.json
    data/perfettoSqlIndex.json
"""

import json
import re
import sys
from datetime import datetime
import os
from pathlib import Path

# Paths
SCRIPT_DIR = Path(__file__).parent
BACKEND_DIR = SCRIPT_DIR.parent
REPO_ROOT = BACKEND_DIR.parent
PERFETTO_DIR = Path(
    os.environ.get("PERFETTO_SOURCE_ROOT", REPO_ROOT / "perfetto")
).resolve()
STDLIB_DIR = PERFETTO_DIR / "src" / "trace_processor" / "perfetto_sql" / "stdlib"
METRICS_DIR = PERFETTO_DIR / "src" / "trace_processor" / "metrics" / "sql"
LIGHT_OUTPUT_FILE = BACKEND_DIR / "data" / "perfettoSqlIndex.light.json"
FULL_OUTPUT_FILE = BACKEND_DIR / "data" / "perfettoSqlIndex.json"
# Relative path stored in output — portable across machines, no /Users/<name> leak.
STDLIB_REL = "perfetto/src/trace_processor/perfetto_sql/stdlib"
METRICS_REL = "perfetto/src/trace_processor/metrics/sql"
GENERATED_FROM = os.environ.get("PERFETTO_GENERATED_FROM")

# Also extract from the built-in views/tables
BUILTIN_DIR = PERFETTO_DIR / "src" / "trace_processor" / "perfetto_sql" / "stdlib" / "prelude"

# Pattern to match CREATE PERFETTO declarations
CREATE_RE = re.compile(
    r"CREATE\s+PERFETTO\s+(FUNCTION|TABLE|VIEW|MACRO)\s+"
    r"(\w+(?:\.\w+)*)\s*\(",
    re.IGNORECASE,
)

# Pattern for simpler CREATE VIEW/TABLE ... AS declarations without column parens.
CREATE_SIMPLE_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?PERFETTO\s+(VIEW|TABLE)\s+"
    r"(\w+(?:\.\w+)*)\s+AS\b",
    re.IGNORECASE,
)

# Pattern for RETURNS TABLE columns
RETURNS_COL_RE = re.compile(
    r"^\s+--\s+(.+)$"
)

def extract_doc_comment(lines: list[str], decl_line_idx: int) -> str:
    """Extract the documentation comment block immediately before a declaration."""
    comments = []
    i = decl_line_idx - 1

    # Walk backwards through comment lines
    while i >= 0:
        line = lines[i].strip()
        if line.startswith("--"):
            text = line[2:].strip()
            # Stop at copyright block
            if "Copyright" in text and "Android Open Source" in text:
                break
            if "Licensed under" in text or "Apache License" in text:
                break
            if text == "":
                # Empty comment line — might be separator
                if comments:
                    # Check if next line up is also a comment
                    if i > 0 and lines[i - 1].strip().startswith("--"):
                        comments.insert(0, "")
                        i -= 1
                        continue
                    break
                i -= 1
                continue
            comments.insert(0, text)
        else:
            break
        i -= 1

    return " ".join(c for c in comments if c).strip()


def extract_params(lines: list[str], start_idx: int) -> list[dict]:
    """Extract function parameters with their doc comments."""
    params = []
    i = start_idx
    current_comment = ""

    while i < len(lines):
        line = lines[i].strip()

        # Doc comment for parameter
        if line.startswith("--"):
            current_comment = line[2:].strip()
            i += 1
            continue

        # Parameter line (name TYPE)
        param_match = re.match(r"(\w+)\s+([\w().,\s]+?)(?:,\s*)?$", line)
        if param_match:
            name = param_match.group(1)
            ptype = param_match.group(2).strip()
            if name.upper() not in ("RETURNS", "AS", "BEGIN"):
                params.append({
                    "name": name,
                    "type": ptype,
                    "description": current_comment,
                })
            current_comment = ""

        # End of parameters
        if ")" in line and not line.startswith("--"):
            break

        i += 1

    return params


def extract_return_columns(lines: list[str], start_idx: int) -> list[dict]:
    """Extract RETURNS TABLE columns."""
    columns = []
    i = start_idx
    current_comment = ""
    in_returns = False

    while i < len(lines):
        line = lines[i].strip()

        if "RETURNS TABLE" in line.upper():
            in_returns = True
            i += 1
            continue

        if not in_returns:
            i += 1
            continue

        if line.startswith("--"):
            current_comment = line[2:].strip()
            i += 1
            continue

        col_match = re.match(r"(\w+)\s+([\w().,\s]+?)(?:,\s*)?$", line)
        if col_match:
            name = col_match.group(1)
            ctype = col_match.group(2).strip()
            columns.append({
                "name": name,
                "type": ctype,
                "description": current_comment,
            })
            current_comment = ""

        if line.startswith(")"):
            break

        i += 1

    return columns


# Pattern for @column annotations in doc comments
AT_COLUMN_RE = re.compile(
    r"^--\s+@column\s+(?:(\w+)\s+)?(\w+)\s+(.*?)$"
)
INCLUDE_MODULE_RE = re.compile(r"INCLUDE\s+PERFETTO\s+MODULE\s+([\w.]+)", re.IGNORECASE)
RUN_METRIC_RE = re.compile(r"RUN_METRIC\s*\(\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)


def extract_at_columns(lines: list[str], decl_line_idx: int) -> list[dict]:
    """Extract @column annotations from doc comments above a declaration.

    Supports two formats found in the Perfetto stdlib:
      -- @column column_name   Description text
      -- @column TYPE column_name   Description text
    """
    columns = []
    i = decl_line_idx - 1

    while i >= 0:
        line = lines[i].strip()
        if not line.startswith("--"):
            break

        # Stop at copyright block
        text = line[2:].strip()
        if "Copyright" in text and "Android Open Source" in text:
            break
        if "Licensed under" in text or "Apache License" in text:
            break

        # Match @column annotations
        m = re.match(r"@column\s+(\w+)\s+(\w+)\s*(.*)", text)
        if m:
            # Format: @column TYPE name Description
            columns.insert(0, {
                "name": m.group(2),
                "type": m.group(1),
                "description": m.group(3).strip(),
            })
        else:
            m2 = re.match(r"@column\s+(\w+)\s*(.*)", text)
            if m2:
                # Format: @column name Description
                columns.insert(0, {
                    "name": m2.group(1),
                    "type": "UNKNOWN",
                    "description": m2.group(2).strip(),
                })

        i -= 1

    return columns


def extract_view_columns(lines: list[str], start_idx: int) -> list[dict]:
    """Extract columns from CREATE PERFETTO VIEW name (...) declarations.

    Views define columns in parentheses directly after the name, using the
    same format as function parameters:
      CREATE PERFETTO VIEW name (
        -- Column description.
        col_name TYPE,
        ...
      )
    """
    columns = []
    i = start_idx
    current_comment = ""

    while i < len(lines):
        line = lines[i].strip()

        if line.startswith("--"):
            current_comment = line[2:].strip()
            i += 1
            continue

        col_match = re.match(r"(\w+)\s+([\w().,\s]+?)(?:,\s*)?$", line)
        if col_match:
            name = col_match.group(1)
            ctype = col_match.group(2).strip()
            if name.upper() not in ("AS", "SELECT", "WITH"):
                columns.append({
                    "name": name,
                    "type": ctype,
                    "description": current_comment,
                })
            current_comment = ""

        if ")" in line and not line.startswith("--"):
            break

        i += 1

    return columns


def split_view_block(lines: list[str], decl_line_idx: int) -> str:
    """Return SQL text for one CREATE view/table block."""
    block = []
    for line in lines[decl_line_idx:]:
        if block and re.match(r"\s*(DROP|CREATE)\s+", line, re.IGNORECASE):
            break
        block.append(line)
    return "\n".join(block)


def split_select_expressions(select_list: str) -> list[str]:
    """Split a SELECT list on top-level commas."""
    expressions = []
    current = []
    depth = 0
    quote = ""
    i = 0
    while i < len(select_list):
        ch = select_list[i]
        if quote:
            current.append(ch)
            if ch == quote:
                quote = ""
            elif ch == "\\" and i + 1 < len(select_list):
                i += 1
                current.append(select_list[i])
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            current.append(ch)
        elif ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth = max(0, depth - 1)
            current.append(ch)
        elif ch == "," and depth == 0:
            expressions.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    if current:
        expressions.append("".join(current))
    return expressions


def extract_select_alias_columns(lines: list[str], decl_line_idx: int) -> list[dict]:
    """Best-effort output columns for CREATE ... AS SELECT views.

    Perfetto metric SQL often declares output views as `CREATE PERFETTO VIEW
    name AS WITH ... SELECT ...`; those files do not expose column declarations,
    but the final SELECT aliases are still useful for lookup_sql_schema.
    """
    block = split_view_block(lines, decl_line_idx)
    select_positions = [m.start() for m in re.finditer(r"\bSELECT\b", block, re.IGNORECASE)]
    if not select_positions:
        return []
    select_start = select_positions[-1]
    from_match = re.search(r"\bFROM\b", block[select_start:], re.IGNORECASE)
    if not from_match:
        return []
    select_list = block[select_start + len("SELECT"):select_start + from_match.start()]
    columns = []
    for raw_part in split_select_expressions(select_list):
        part = " ".join(raw_part.strip().split())
        if not part:
            continue
        alias_match = re.search(r"\bAS\s+([A-Za-z_]\w*)$", part, re.IGNORECASE)
        if alias_match:
            name = alias_match.group(1)
        else:
            direct_match = re.match(r"^([A-Za-z_]\w*)$", part)
            if not direct_match:
                continue
            name = direct_match.group(1)
        columns.append({
            "name": name,
            "type": "UNKNOWN",
            "description": "",
        })
    return columns


def extract_dependencies(content: str) -> list[str]:
    """Extract module/metric dependencies from a SQL file."""
    deps = []
    deps.extend(INCLUDE_MODULE_RE.findall(content))
    deps.extend(f"metric:{m}" for m in RUN_METRIC_RE.findall(content))
    return sorted(set(deps))


def source_file_path(filepath: Path, source_dir: Path) -> str:
    """Return a portable path relative to the given SQL source root."""
    return filepath.relative_to(source_dir).as_posix()


def enrich_full_entry(entry: dict, filepath: Path, source_dir: Path, content: str) -> dict:
    """Attach full-index-only fields while preserving the light entry shape."""
    full = dict(entry)
    rel = source_file_path(filepath, source_dir)
    parts = Path(rel).parts
    if len(parts) > 2 and "subcategory" not in full:
        full["subcategory"] = ".".join(parts[1:-1])
    full["sql"] = content
    full["filePath"] = rel
    dependencies = set(full.get("dependencies", []))
    dependencies.update(extract_dependencies(content))
    full["dependencies"] = sorted(dependencies)
    return full


def stdlib_file_entry(filepath: Path, content: str, category: str) -> dict:
    """Create a backwards-compatible full-index entry for a stdlib SQL file."""
    rel = source_file_path(filepath, STDLIB_DIR)
    name = filepath.stem
    return {
        "id": f"stdlib.{category}.{name}",
        "name": name,
        "category": category,
        "type": "view",
        "description": f"Stdlib module SQL: {rel}",
        "sql": content,
        "filePath": rel,
        "dependencies": extract_dependencies(content),
    }


def metric_file_entry(filepath: Path, content: str, *, full: bool) -> dict:
    """Create a file-level entry for RUN_METRIC-style metric SQL files."""
    rel = source_file_path(filepath, METRICS_DIR)
    rel_no_ext = rel[:-4] if rel.endswith(".sql") else rel
    parts = Path(rel_no_ext).parts
    category = parts[0] if parts else "metric"
    name = Path(rel_no_ext).name
    entry = {
        "id": "metric." + ".".join(parts),
        "name": name,
        "category": category,
        "type": "metric",
        "description": f"Metric SQL: {rel}",
    }
    if len(parts) > 2:
        entry["subcategory"] = ".".join(parts[1:-1])
    if full:
        entry["sql"] = content
        entry["filePath"] = rel
        entry["dependencies"] = extract_dependencies(content)
    return entry


def annotate_metric_declaration(entry: dict, filepath: Path) -> dict:
    """Mark a metric-created declaration with the RUN_METRIC setup it needs."""
    rel = source_file_path(filepath, METRICS_DIR)
    annotated = dict(entry)
    dependencies = set(annotated.get("dependencies", []))
    dependencies.add(f"metric:{rel}")
    annotated["dependencies"] = sorted(dependencies)
    annotated["requiredMetric"] = rel
    annotated["setupSql"] = f"SELECT RUN_METRIC('{rel}');"
    return annotated


def parse_sql_file(filepath: Path, category: str, id_prefix: str = "stdlib") -> list[dict]:
    """Parse a single SQL file and extract all declarations."""
    templates = []

    try:
        content = filepath.read_text(encoding="utf-8")
    except Exception:
        return templates

    lines = content.split("\n")

    for i, line in enumerate(lines):
        match = CREATE_RE.search(line)
        if not match:
            # Try simpler CREATE VIEW/TABLE (no parens after name).
            simple_match = CREATE_SIMPLE_RE.search(line)
            if simple_match:
                decl_type = simple_match.group(1).lower()
                name = simple_match.group(2)
                desc = extract_doc_comment(lines, i)
                # Try @column annotations from doc comments
                columns = extract_at_columns(lines, i)
                if not columns:
                    columns = extract_select_alias_columns(lines, i)
                templates.append({
                    "id": f"{id_prefix}.{category}.{name}",
                    "name": name,
                    "category": category,
                    "type": decl_type,
                    "description": desc or f"{decl_type.title()}: {name}",
                    "columns": [{"name": c["name"], "type": c["type"]} for c in columns] if columns else [],
                })
            continue

        decl_type = match.group(1).lower()  # function, table, view, macro
        name = match.group(2)

        desc = extract_doc_comment(lines, i)
        params = extract_params(lines, i + 1) if decl_type == "function" else []

        # Extract columns based on declaration type
        if decl_type in ("function", "table"):
            columns = extract_return_columns(lines, i)
        elif decl_type == "view":
            # View columns are in parens directly after the name (same format as params)
            columns = extract_view_columns(lines, i + 1)
        else:
            columns = []

        # Fallback: try @column annotations from doc comments if no inline columns found
        if not columns and decl_type in ("view", "table"):
            columns = extract_at_columns(lines, i)
        if not columns and decl_type == "view":
            columns = extract_select_alias_columns(lines, i)

        # Build template entry
        entry = {
            "id": f"{id_prefix}.{category}.{name}",
            "name": name,
            "category": category,
            "type": decl_type,
            "description": desc or f"{decl_type.title()}: {name}",
        }

        if columns:
            entry["columns"] = [{"name": c["name"], "type": c["type"]} for c in columns]
        if params:
            entry["params"] = [{"name": p["name"], "type": p["type"]} for p in params]

        templates.append(entry)

    return templates


def dedupe_by_name(templates: list[dict]) -> list[dict]:
    """Deduplicate light-index entries by name, preserving first occurrence."""
    seen = set()
    unique_templates = []
    for t in templates:
        if t["name"] not in seen:
            seen.add(t["name"])
            unique_templates.append(t)
    return unique_templates


def dedupe_by_id(templates: list[dict]) -> list[dict]:
    """Deduplicate full-index entries by id, preserving first occurrence."""
    seen = set()
    unique_templates = []
    for t in templates:
        if t["id"] not in seen:
            seen.add(t["id"])
            unique_templates.append(t)
    return unique_templates


def build_stats(templates: list[dict]) -> dict:
    by_category = {}
    for t in templates:
        category = t.get("category", "unknown")
        typ = t.get("type", "unknown")
        cat = by_category.setdefault(category, {"count": 0, "types": {}})
        cat["count"] += 1
        cat["types"][typ] = cat["types"].get(typ, 0) + 1
    return {
        "totalTemplates": len(templates),
        "byCategory": by_category,
    }


def main():
    if not STDLIB_DIR.exists():
        print(f"Error: stdlib directory not found at {STDLIB_DIR}", file=sys.stderr)
        sys.exit(1)
    if not METRICS_DIR.exists():
        print(f"Error: metrics SQL directory not found at {METRICS_DIR}", file=sys.stderr)
        sys.exit(1)

    light_templates = []
    full_templates = []
    stdlib_file_count = 0
    declaration_file_count = 0
    metrics_file_count = 0

    # Walk through all .sql files in stdlib
    for sql_file in sorted(STDLIB_DIR.rglob("*.sql")):
        rel = sql_file.relative_to(STDLIB_DIR)
        parts = list(rel.parts)

        # Category is the top-level directory (android, slices, counters, etc.)
        category = parts[0] if len(parts) > 1 else "core"

        # Skip internal/test files
        if any(p.startswith("_") or p == "test" for p in parts[:-1]):
            continue

        stdlib_file_count += 1
        content = sql_file.read_text(encoding="utf-8")
        templates = parse_sql_file(sql_file, category)
        if templates:
            light_templates.extend(templates)
            full_templates.extend(
                enrich_full_entry(t, sql_file, STDLIB_DIR, content)
                for t in templates
            )
            declaration_file_count += 1
        full_templates.append(stdlib_file_entry(sql_file, content, category))

    # Walk through metric SQL files as well. These are not stdlib modules but
    # they define RUN_METRIC outputs and intermediate views that strategies can
    # reference after SELECT RUN_METRIC(...).
    for sql_file in sorted(METRICS_DIR.rglob("*.sql")):
        rel = sql_file.relative_to(METRICS_DIR)
        parts = list(rel.parts)
        if any(p == "test" for p in parts[:-1]):
            continue
        category = parts[0] if len(parts) > 1 else "metric"
        content = sql_file.read_text(encoding="utf-8")
        parsed = [
            annotate_metric_declaration(t, sql_file)
            for t in parse_sql_file(sql_file, category, id_prefix="metric")
        ]
        if parsed:
            light_templates.extend(parsed)
            full_templates.extend(
                enrich_full_entry(t, sql_file, METRICS_DIR, content)
                for t in parsed
            )
        file_entry_light = metric_file_entry(sql_file, content, full=False)
        file_entry_full = metric_file_entry(sql_file, content, full=True)
        light_templates.append(file_entry_light)
        full_templates.append(file_entry_full)
        metrics_file_count += 1

    unique_light_templates = dedupe_by_name(light_templates)
    unique_full_templates = dedupe_by_id(full_templates)

    # Build outputs
    light_output = {
        "version": "2.0",
        "generatedAt": datetime.now().isoformat(),
        "generatedFrom": GENERATED_FROM,
        "source": STDLIB_REL,
        "templates": unique_light_templates,
        "scenarios": [],  # Preserved for compatibility
    }
    full_output = {
        "version": "2.0",
        "generatedAt": datetime.now().isoformat(),
        "generatedFrom": GENERATED_FROM,
        "source": {
            "stdlib": STDLIB_REL,
            "metrics": METRICS_REL,
        },
        "stats": build_stats(unique_full_templates),
        "templates": unique_full_templates,
        "scenarios": [],  # Preserved for compatibility
    }

    # Write outputs
    LIGHT_OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LIGHT_OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(light_output, f, indent=2, ensure_ascii=False)
    with open(FULL_OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(full_output, f, indent=2, ensure_ascii=False)

    # Stats
    types = {}
    desc_quality = {"good": 0, "placeholder": 0}
    with_columns = 0
    total_columns = 0
    for t in unique_light_templates:
        types[t["type"]] = types.get(t["type"], 0) + 1
        if t["description"].startswith(("Function:", "View:", "Table:", "Macro:")) or len(t["description"]) < 10:
            desc_quality["placeholder"] += 1
        else:
            desc_quality["good"] += 1
        if t.get("columns"):
            with_columns += 1
            total_columns += len(t["columns"])

    print(f"Regenerated {LIGHT_OUTPUT_FILE.name} and {FULL_OUTPUT_FILE.name}")
    print(f"  Stdlib files scanned: {stdlib_file_count}")
    print(f"  Stdlib files with declarations: {declaration_file_count}")
    print(f"  Metric files scanned: {metrics_file_count}")
    print(f"  Light templates: {len(unique_light_templates)}")
    print(f"  Full templates: {len(unique_full_templates)}")
    print(f"  Types: {types}")
    print(f"  Description quality: {desc_quality['good']} good, {desc_quality['placeholder']} placeholder")
    print(f"  Column coverage: {with_columns}/{len(unique_light_templates)} templates ({total_columns} total columns)")


if __name__ == "__main__":
    main()
