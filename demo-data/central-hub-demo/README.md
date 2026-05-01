# Central Hub Demo

Use these files when you want the graph to form around one central node.

Central node: Acme Corp

Every document repeats explicit relationships to Acme Corp so the extractor should build one connected graph instead of isolated edge pairs.

The employee roster file is intentionally direct: it repeats "Acme Corp employs ..." for each person so employee nodes connect to the central company node.
