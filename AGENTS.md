# 專案規則

## 推送前測試規則

- 每次 `git push` 必須透過 `.githooks/pre-push` 執行 `npm run test:ci`；任何測試或檢查失敗都必須阻止推送。
- 新增或修改自動化測試時，必須確認測試會由 `test:ci` 直接或間接執行；未被既有測試探索規則納入時，同一筆變更必須更新測試入口。不得只新增測試檔卻漏接 hook。
- 本機測試不得執行正式環境部署、遠端資料庫遷移、內容發布或正式資料寫入。
- 每個 checkout 先執行 `npm run prepare`（`npm install`／`npm ci` 也會自動安裝 hook），並確認 `git config --local core.hooksPath` 為 `.githooks`。不得使用 `--no-verify`、停用 hook 或略過失敗測試來推送。
