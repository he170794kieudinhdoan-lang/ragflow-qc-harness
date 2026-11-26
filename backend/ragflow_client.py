import httpx
from typing import Any, Dict, List, Optional

_SHARED_HTTP_CLIENT: Optional[httpx.AsyncClient] = None


def get_shared_http_client() -> httpx.AsyncClient:
    """Shared bounded connection pool to prevent TCP socket buildup across requests."""
    global _SHARED_HTTP_CLIENT
    if _SHARED_HTTP_CLIENT is None or _SHARED_HTTP_CLIENT.is_closed:
        _SHARED_HTTP_CLIENT = httpx.AsyncClient(
            timeout=60.0,
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=10,
                keepalive_expiry=30.0,
            ),
        )
    return _SHARED_HTTP_CLIENT


async def close_shared_http_client() -> None:
    global _SHARED_HTTP_CLIENT
    if _SHARED_HTTP_CLIENT is not None and not _SHARED_HTTP_CLIENT.is_closed:
        await _SHARED_HTTP_CLIENT.aclose()
    _SHARED_HTTP_CLIENT = None


class RAGFlowError(Exception):
    def __init__(self, message: str, code: int = -1, status_code: int = 0):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class RAGFlowClient:
    """Async HTTP client wrapping RAGFlow /api/v1 endpoints."""

    def __init__(self, base_url: str, api_key: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key.strip()
        self.timeout = timeout

    def _headers(self, json_content: bool = True) -> Dict[str, str]:
        h = {"Authorization": f"Bearer {self.api_key}"}
        if json_content:
            h["Content-Type"] = "application/json"
        return h

    def _unwrap(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            raise RAGFlowError(
                f"HTTP {resp.status_code}: {resp.text[:300]}",
                status_code=resp.status_code,
            )
        payload = resp.json()
        code = payload.get("code", 0)
        if code != 0:
            raise RAGFlowError(
                payload.get("message", f"RAGFlow API error code {code}"),
                code=code,
                status_code=resp.status_code,
            )
        return payload.get("data")

    async def test_connection(self) -> Dict[str, Any]:
        datasets = await self.list_datasets(page=1, page_size=50)
        return {"ok": True, "dataset_count": len(datasets), "datasets": datasets}

    # --- Datasets ---
    async def list_datasets(self, page: int = 1, page_size: int = 100) -> List[Dict[str, Any]]:
        page_size = max(1, min(int(page_size), 100))
        client = get_shared_http_client()
        r = await client.get(
            f"{self.base_url}/api/v1/datasets",
            headers=self._headers(),
            params={"page": page, "page_size": page_size},
            timeout=self.timeout,
        )
        data = self._unwrap(r)
        return data if isinstance(data, list) else []

    async def create_dataset(
        self,
        name: str,
        chunk_method: str = "naive",
        embedding_model: Optional[str] = None,
        parser_config: Optional[Dict[str, Any]] = None,
        description: str = "",
    ) -> Dict[str, Any]:
        # RAGFlow Go API (v0.22+) uses parse_type (1 = BuiltIn) + parser_id
        parser_id = chunk_method or "naive"
        body: Dict[str, Any] = {
            "name": name,
            "parse_type": 1,
            "parser_id": parser_id,
        }
        if embedding_model:
            body["embedding_model"] = embedding_model
        if parser_config:
            body["parser_config"] = parser_config
        client = get_shared_http_client()
        r = await client.post(
            f"{self.base_url}/api/v1/datasets",
            headers=self._headers(),
            json=body,
            timeout=self.timeout,
        )
        try:
            return self._unwrap(r)
        except RAGFlowError as e:
            # Fallback for older Python RAGFlow versions that reject parse_type/parser_id
            if "parse_type" in str(e) or "parser_id" in str(e):
                legacy_body: Dict[str, Any] = {"name": name, "chunk_method": parser_id}
                if embedding_model:
                    legacy_body["embedding_model"] = embedding_model
                if parser_config:
                    legacy_body["parser_config"] = parser_config
                r2 = await client.post(
                    f"{self.base_url}/api/v1/datasets",
                    headers=self._headers(),
                    json=legacy_body,
                    timeout=self.timeout,
                )
                return self._unwrap(r2)
            raise

    async def get_dataset(self, dataset_id: str) -> Optional[Dict[str, Any]]:
        client = get_shared_http_client()
        r = await client.get(
            f"{self.base_url}/api/v1/datasets",
            headers=self._headers(),
            params={"id": dataset_id, "page": 1, "page_size": 10},
            timeout=self.timeout,
        )
        data = self._unwrap(r)
        if isinstance(data, list):
            for ds in data:
                if ds.get("id") == dataset_id:
                    return ds
            return data[0] if data else None
        return data if isinstance(data, dict) else None

    async def update_dataset(
        self,
        dataset_id: str,
        chunk_method: Optional[str] = None,
        parser_config: Optional[Dict[str, Any]] = None,
        pagerank: Optional[int] = None,
    ) -> Any:
        body: Dict[str, Any] = {"parse_type": 1}
        if chunk_method:
            body["parser_id"] = chunk_method
        if parser_config is not None:
            body["parser_config"] = parser_config
        if pagerank is not None:
            body["pagerank"] = int(pagerank)
        client = get_shared_http_client()
        r = await client.put(
            f"{self.base_url}/api/v1/datasets/{dataset_id}",
            headers=self._headers(),
            json=body,
            timeout=self.timeout,
        )
        try:
            return self._unwrap(r)
        except RAGFlowError as e:
            if "parser_id" in str(e) or "chunk_method" in str(e):
                fallback: Dict[str, Any] = {}
                if chunk_method:
                    fallback["chunk_method" if "parser_id" in str(e) else "parser_id"] = chunk_method
                if parser_config is not None:
                    fallback["parser_config"] = parser_config
                if pagerank is not None:
                    fallback["pagerank"] = int(pagerank)
                r2 = await client.put(
                    f"{self.base_url}/api/v1/datasets/{dataset_id}",
                    headers=self._headers(),
                    json=fallback,
                    timeout=self.timeout,
                )
                return self._unwrap(r2)
            raise

    async def delete_datasets(self, dataset_ids: List[str]) -> Any:
        """
        Deletes specific RAGFlow datasets by ID.
        Guards strictly against sending empty/null `ids` (RAGFlow deletes ALL datasets if `ids` is null).
        """
        clean_ids = [str(i).strip() for i in (dataset_ids or []) if str(i).strip()]
        if not clean_ids:
            return {"skipped": True}
        client = get_shared_http_client()
        r = await client.request(
            "DELETE",
            f"{self.base_url}/api/v1/datasets",
            headers=self._headers(),
            json={"ids": clean_ids},
            timeout=self.timeout,
        )
        return self._unwrap(r)

    # --- Documents ---
    async def list_documents(
        self, dataset_id: str, page: int = 1, page_size: int = 100
    ) -> List[Dict[str, Any]]:
        page_size = max(1, min(int(page_size), 100))
        client = get_shared_http_client()
        all_docs: List[Dict[str, Any]] = []
        seen_ids = set()
        current_page = page

        while True:
            r = await client.get(
                f"{self.base_url}/api/v1/datasets/{dataset_id}/documents",
                headers=self._headers(),
                params={"page": current_page, "page_size": page_size},
                timeout=self.timeout,
            )
            data = self._unwrap(r)
            if isinstance(data, dict) and "docs" in data:
                docs = data.get("docs") or []
                total = int(data.get("total") or 0)
            elif isinstance(data, list):
                docs = data
                total = len(docs)
            else:
                break

            if not docs:
                break

            added = 0
            for d in docs:
                doc_id = d.get("id") if isinstance(d, dict) else None
                if doc_id is None or doc_id not in seen_ids:
                    if doc_id is not None:
                        seen_ids.add(doc_id)
                    all_docs.append(d)
                    added += 1

            if added == 0:
                break
            if total > 0 and len(all_docs) >= total:
                break
            if not (isinstance(data, dict) and "docs" in data):
                break
            current_page += 1
            if current_page > 100:
                break

        return all_docs

    async def upload_document(self, dataset_id: str, filename: str, file_bytes: bytes) -> Any:
        client = get_shared_http_client()
        files = [("file", (filename, file_bytes))]
        r = await client.post(
            f"{self.base_url}/api/v1/datasets/{dataset_id}/documents",
            headers=self._headers(json_content=False),
            files=files,
            timeout=120.0,
        )
        return self._unwrap(r)

    async def download_document(self, dataset_id: str, document_id: str) -> bytes:
        client = get_shared_http_client()
        r = await client.get(
            f"{self.base_url}/api/v1/datasets/{dataset_id}/documents/{document_id}",
            headers=self._headers(json_content=False),
            timeout=120.0,
        )
        if r.status_code >= 400:
            raise RAGFlowError(
                f"HTTP {r.status_code}: {r.text[:300]}",
                status_code=r.status_code,
            )
        ctype = (r.headers.get("content-type") or "").lower()
        if "application/json" in ctype:
            try:
                payload = r.json()
                if isinstance(payload, dict) and payload.get("code", 0) != 0:
                    raise RAGFlowError(
                        payload.get("message", f"RAGFlow API error code {payload.get('code')}"),
                        code=payload.get("code", -1),
                        status_code=r.status_code,
                    )
            except RAGFlowError:
                raise
            except Exception:
                pass
        return r.content

    async def parse_documents(self, dataset_id: str, document_ids: List[str]) -> Any:
        client = get_shared_http_client()
        r = await client.post(
            f"{self.base_url}/api/v1/datasets/{dataset_id}/chunks",
            headers=self._headers(),
            json={"document_ids": document_ids},
            timeout=self.timeout,
        )
        return self._unwrap(r)

    async def stop_parsing(self, dataset_id: str, document_ids: List[str]) -> Any:
        client = get_shared_http_client()
        r = await client.request(
            "DELETE",
            f"{self.base_url}/api/v1/datasets/{dataset_id}/chunks",
            headers=self._headers(),
            json={"document_ids": document_ids},
            timeout=self.timeout,
        )
        return self._unwrap(r)

    # --- Chunks ---
    async def list_chunks(
        self,
        dataset_id: str,
        document_id: str,
        page: int = 1,
        page_size: int = 100,
    ) -> Dict[str, Any]:
        page_size = max(1, min(int(page_size), 100))
        client = get_shared_http_client()
        r = await client.get(
            f"{self.base_url}/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks",
            headers=self._headers(),
            params={"page": page, "page_size": page_size},
            timeout=self.timeout,
        )
        data = self._unwrap(r)
        if isinstance(data, dict):
            return data
        return {"chunks": data if isinstance(data, list) else [], "total": len(data or [])}

    async def list_all_chunks(self, dataset_id: str, document_id: str) -> List[Dict[str, Any]]:
        all_chunks: List[Dict[str, Any]] = []
        page = 1
        page_size = 100
        while True:
            data = await self.list_chunks(dataset_id, document_id, page=page, page_size=page_size)
            batch = data.get("chunks", [])
            if not batch:
                break
            all_chunks.extend(batch)
            total = data.get("total", len(all_chunks))
            if len(all_chunks) >= total or len(batch) < page_size:
                break
            page += 1
        return all_chunks

    # --- Retrieval ---
    async def retrieve(
        self,
        question: str,
        dataset_ids: List[str],
        top_k: int = 10,
        similarity_threshold: float = 0.2,
        vector_similarity_weight: float = 0.3,
        rerank_id: Optional[str] = None,
        keyword: bool = False,
        page: int = 1,
        page_size: int = 10,
        use_kg: bool = False,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "question": question,
            "dataset_ids": dataset_ids,
            "top_k": max(top_k, 1024) if rerank_id else top_k,
            "page": page,
            "page_size": page_size,
            "similarity_threshold": similarity_threshold,
            "vector_similarity_weight": vector_similarity_weight,
            "keyword": keyword,
        }
        if rerank_id:
            body["rerank_id"] = rerank_id
        if use_kg:
            body["use_kg"] = True
        client = get_shared_http_client()
        r = await client.post(
            f"{self.base_url}/api/v1/retrieval",
            headers=self._headers(),
            json=body,
            timeout=self.timeout,
        )
        data = self._unwrap(r)
        return data if isinstance(data, dict) else {"chunks": []}
