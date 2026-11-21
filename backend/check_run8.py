import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from database import get_db

with get_db() as conn:
    run = conn.execute("SELECT * FROM runs WHERE id = 8 OR name LIKE '%test 2%'").fetchone()
    if not run:
        print("Run 8 not found. Available runs:")
        for r in conn.execute("SELECT id, name FROM runs").fetchall():
            print(dict(r))
        exit()

    print("Run:", dict(run))
    run_id = run["id"]

    # Run documents
    rdocs = conn.execute("""
        SELECT rd.*, d.doc_code, d.filename 
        FROM run_documents rd
        JOIN documents d ON d.id = rd.document_id
        WHERE rd.run_id = ?
    """, (run_id,)).fetchall()
    print(f"\nRun Documents ({len(rdocs)}):")
    for rd in rdocs:
        print(f"  [{rd['doc_code']}] {rd['filename']}: status={rd['parse_status']}, chunks={rd['chunk_count']}, ragflow_doc_id={rd['ragflow_doc_id']}")

    # Chunks
    chunks_count = conn.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ?", (run_id,)).fetchone()[0]
    print(f"\nTotal chunks in DB for run {run_id}: {chunks_count}")

    # Check chunks per doc
    chunks_by_doc = conn.execute("""
        SELECT document_id, COUNT(*) as cnt 
        FROM chunks 
        WHERE run_id = ? 
        GROUP BY document_id
    """, (run_id,)).fetchall()
    for cd in chunks_by_doc:
        print(f"  doc_id {cd['document_id']}: {cd['cnt']} chunks")

    # Parsing units
    units = conn.execute("SELECT * FROM parsing_units WHERE run_id = ?", (run_id,)).fetchall()
    print(f"\nTotal parsing units in DB for run {run_id}: {len(units)}")
    matched_cnt = sum(1 for u in units if u["matched_chunk_ids"] and u["matched_chunk_ids"] != "[]")
    print(f"Parsing units with matched chunks: {matched_cnt}/{len(units)}")

    for u in units[:8]:
        print(f"  Unit #{u['unit_index']} (Doc {u['document_id']}): score={u['match_score']}, matched={u['matched_chunk_ids']}, verdict={u['verdict']}")
