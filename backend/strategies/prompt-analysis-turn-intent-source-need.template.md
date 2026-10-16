<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
- sourceNeed：本轮已选择源码。判断答案需要源码的程度，单个字符串：答案只依赖 Trace、不需要代码时为 none；需要指出相关代码在哪里（文件、行、符号、调用点）时为 locate；需要说明代码如何运作或为何导致现象、必须读实现时为 mechanism。按请求的真实语义判断，不按词语出现与否；源码只解释机制，不改变 taskKind 或 deliverable。acknowledgement 必须为 none。
