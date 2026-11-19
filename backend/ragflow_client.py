import httpx
from typing import Any, Dict, List, Optional


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
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.get(
                f"{self.base_url}/api/v1/datasets",
                headers=self._headers(),
                params={"page": page, "page_size": page_size},
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
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{self.base_url}/api/v1/datasets",
                headers=self._headers(),
                json=body,
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
                    )
                    return self._unwrap(r2)
                raise

    # --- Documents ---
    async def list_documents(
        self, dataset_id: str, page: int = 1, page_size: int = 100
    ) -> List[Dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.get(
                f"{self.base_url}/api/v1/datasets/{dataset_id}/documents",
                headers=self._headers(),
                params={"page": page, "page_size": page_size},
            )
            data = self._unwrap(r)
            if isinstance(data, dict) and "docs" in data:
                return data["docs"]
            return data if isinstance(data, list) else []

    async def upload_document(self, dataset_id: str, filename: str, file_bytes: bytes) -> Any:
        async with httpx.AsyncClient(timeout=120.0) as client:
            files = [("file", (filename, file_bytes))]
            r = await client.post(
                f"{self.base_url}/api/v1/datasets/{dataset_id}/documents",
                headers=self._headers(json_content=False),
                files=files,
            )
            return self._unwrap(r)

    async def download_document(self, dataset_id: str, document_id: str) -> bytes:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.get(
                f"{self.base_url}/api/v1/datasets/{dataset_id}/documents/{document_id}",
                headers=self._headers(json_content=False),
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
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{self.base_url}/api/v1/datasets/{dataset_id}/chunks",
                headers=self._headers(),
                json={"document_ids": document_ids},
            )
            return self._unwrap(r)

    async def stop_parsing(self, dataset_id: str, document_ids: List[str]) -> Any:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.request(
                "DELETE",
                f"{self.base_url}/api/v1/datasets/{dataset_id}/chunks",
                headers=self._headers(),
                json={"document_ids": document_ids},
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
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.get(
                f"{self.base_url}/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks",
                headers=self._headers(),
                params={"page": page, "page_size": page_size},
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
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{self.base_url}/api/v1/retrieval",
                headers=self._headers(),
                json=body,
            )
            data = self._unwrap(r)
            return data if isinstance(data, dict) else {"chunks": []}
