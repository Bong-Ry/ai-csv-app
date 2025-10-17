require('dotenv').config();
const express = require('express');
const path = require('path');
const { OpenAI } = require('openai');
const cors = require('cors');
const multer = require('multer'); // ★ ファイルアップロード用
const Papa = require('papaparse'); // ★ CSV解析用

const app = express();
const port = process.env.PORT || 3000;
const BATCH_SIZE = 100; // バッチサイズ
const MAX_PROCESS_LIMIT = 1000; // ★ 最大処理件数を定数化

// ログ用のヘルパー
const getTimestamp = () => new Date().toISOString();

// ログ関数
const logInfo = (message, context = '') => {
  console.log(`[${getTimestamp()}] [INFO] ${message}`, context);
};
const logWarn = (message, context = '') => {
  console.warn(`[${getTimestamp()}] [WARN] ${message}`, context);
};
const logError = (message, error) => {
  console.error(`[${getTimestamp()}] [ERROR] ${message}`, error ? error.message : '', error || '');
};

// APIキーのチェック
if (!process.env.OPENAI_API_KEY) {
  logError("エラー: OPENAI_API_KEY が .env ファイルに設定されていません。");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Multer の設定 (CSVファイルをメモリ上で扱う)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ミドルウェアの設定
app.use(cors());
app.use(express.json({ limit: '10mb' })); // JSONリクエストの上限 (念のため残す)
app.use(express.static(path.join(__dirname)));

// ルートエンドポイント
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ★★★ AI処理のコア関数 ★★★
// (旧 /api/process のロジックを関数化)
async function processBatchWithAI(titles, batchIndex) {
  const batchSize = titles.length;
  logInfo(`[AI Batch ${batchIndex}] Calling OpenAI API for ${batchSize} titles...`);

  // ★★★ プロンプト修正点 (userPrompt) ★★★
  const userPrompt = `
以下のリストは、商品タイトルの文字列リストです。
${JSON.stringify(titles, null, 2)}
リスト内の各タイトル文字列について、以下のタスクを実行してください。

アーティスト名 (artist):
文字列から最も可能性の高いアーティスト名を英語で特定します。
一般的なスペルミス（例: "Doubie Brothers"）は "The Doobie Brothers" のように修正します。

リリースタイトル (release_title):
文字列から正確なアルバム名やシングル名を英語で特定します。
"CD", "Used", "Vinyl", "LP", "with Sleeve", "Used" などのステータス、フォーマット、コンディションに関する余分な情報は削除します。
**重要:** もし余分な情報を削除した結果、タイトルが空白（空欄）になる場合は、**空白を返さず**、元の文字列から判断できる最も可能性の高い正式なリリースタイトルを返してください。
**"Unknown" とは絶対に回答しないでください。**

原産国 (country_of_origin):
まず、タイトル文字列内に国名（例: "Japan", "UK", "US"）が明記されているか確認し、あればそれを採用します。
タイトル内に情報がない場合は、アーティスト名やリリースタイトル、型番（例: WPCR-2653）などを基に、そのリリースの主な製造国または販売国を推測します。
**フォールバック:** 上記の手順でも製造国が特定困難な場合に限り、アーティストの主な活動国（例: The Beatles なら "UK"）を推測して回答します。
**最終手段:** すべての手がかりを使っても特定が困難な場合のみ "Unknown" としてください。

出力形式:
抽出した情報を、以下のJSONオブジェクトのリスト（配列）形式で出力してください。 他の説明文や前置き（「承知いたしました」など）は一切含めず、JSONデータのみを返してください。
[
  {
    "country_of_origin": "（原産国を英語で）",
    "artist": "（アーティスト名を英語で）",
    "release_title": "（リリースタイトルを英語で）"
  }
]
`;
  // ★★★ プロンプト修正ここまで ★★★


  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          // ★★★ プロンプト修正点 (system) ★★★
          role: "system",
          content: "あなたは、DiscogsやMusicBrainzのような大規模音楽データベースの知識を持つ、音楽カタログ解析の専門AIです。提供された商品タイトル（CD、レコード、LP、シングルなど）のリストを分析し、各項目から「アーティスト名」「リリースタイトル」「原産国」を**推測ではなく、データベース検索のように**正確に特定します。"
        },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
    });

    logInfo(`[AI Batch ${batchIndex}] Received response from OpenAI.`);
    const responseContent = completion.choices[0].message.content;

    let aiData;
    try {
      const parsedResponse = JSON.parse(responseContent);
      if (Array.isArray(parsedResponse)) {
        aiData = parsedResponse;
      } else if (typeof parsedResponse === 'object' && parsedResponse !== null) {
        const firstKey = Object.keys(parsedResponse)[0];
        if (firstKey && Array.isArray(parsedResponse[firstKey])) {
          aiData = parsedResponse[firstKey];
        } else {
          logWarn(`[AI Batch ${batchIndex}] AI response was object, but not valid array.`, parsedResponse);
          aiData = [];
        }
      } else {
        logWarn(`[AI Batch ${batchIndex}] AI response was not array or object.`, parsedResponse);
        aiData = [];
      }
    } catch (e) {
      logError(`[AI Batch ${batchIndex}] Failed to parse AI JSON response:`, e);
      aiData = [];
    }

    // AIの応答がリクエスト数より少ない場合、エラーとして扱う
    if (aiData.length < titles.length) {
      logWarn(`[AI Batch ${batchIndex}] AI response count (${aiData.length}) mismatch request count (${titles.length}). Filling with errors.`);
      // 足りない分をエラーで埋める (インデックスがズレないように)
      const errorResult = { country_of_origin: 'AI Error', artist: 'AI Error', release_title: 'AI Error' };
      while (aiData.length < titles.length) {
        aiData.push(errorResult);
      }
    }
    return aiData;

  } catch (error) {
    logError(`[AI Batch ${batchIndex}] OpenAI API Error:`, error);
    // APIエラー時は、リクエストされた件数分のエラーオブジェクト配列を返す
    return new Array(titles.length).fill({
      country_of_origin: 'API Error',
      artist: 'API Error',
      release_title: 'API Error'
    });
  }
}

// ★★★ 新しいメインエンドポイント (CSVアップロード＆処理) ★★★
app.post('/api/upload', upload.single('csv-file'), async (req, res) => {
  logInfo("Received file upload request.");

  if (!req.file) {
    logWarn("File upload failed: No file provided.");
    return res.status(400).json({ error: 'ファイルが提供されていません。' });
  }

  // ファイルをメモリから文字列に変換
  const csvString = req.file.buffer.toString('utf8');
  logInfo(`File received: ${req.file.originalname}, Size: ${req.file.size} bytes.`);

  // 1. CSV解析
  let fullCsvData;
  try {
    logInfo("Parsing CSV data...");
    const results = Papa.parse(csvString, {
      skipEmptyLines: true,
    });
    fullCsvData = results.data;
    if (fullCsvData.length === 0) {
      logWarn("CSV parsing resulted in 0 rows.");
      return res.status(400).json({ error: 'CSVファイルが空か、読み込めませんでした。' });
    }
    logInfo(`CSV parsing complete. Found ${fullCsvData.length} total rows (including header).`);
  } catch (parseError) {
    logError("CSV parsing failed:", parseError);
    return res.status(500).json({ error: 'CSVの解析に失敗しました。' });
  }

  // 2. AI処理対象のフィルタリング
  logInfo("Filtering rows for AI processing...");
  let itemsToProcess = []; // ★ let に変更
  for (let i = 1; i < fullCsvData.length; i++) { // 1行目(i=0)はヘッダーと仮定
    const row = fullCsvData[i];
    const title = row[1] ? row[1].trim() : "";
    const colD = row[3] ? row[3].trim() : "";
    const colE = row[4] ? row[4].trim() : "";
    const colF = row[5] ? row[5].trim() : "";
    
    // B列(title)があり、D, E, Fのいずれかが空なら処理対象
    if (title !== "" && (colD === "" || colE === "" || colF === "")) {
      itemsToProcess.push({ originalIndex: i, title: title });
    }
  }

  let totalItemsToProcess = itemsToProcess.length; // ★ let に変更
  logInfo(`Filtering complete. Found ${totalItemsToProcess} items to process.`);

  // 1000件を超えていたら、エラーではなく先頭1000件に絞り込む
  if (totalItemsToProcess > MAX_PROCESS_LIMIT) {
    logWarn(`Processing limit exceeded: ${totalItemsToProcess} items. Processing only the first ${MAX_PROCESS_LIMIT} items.`);
    itemsToProcess = itemsToProcess.slice(0, MAX_PROCESS_LIMIT); // ★ 先頭1000件に絞り込む
    totalItemsToProcess = itemsToProcess.length; // ★ 処理件数を更新
  }

  if (totalItemsToProcess === 0) {
    logWarn("No items found for AI processing. Returning original file.");
    // 今回は「処理対象なし」というメッセージを返す
    return res.status(400).json({ error: 'AIによる補完対象の行が見つかりませんでした。' });
  }
  
  // 3. バッチ処理の準備
  const batches = [];
  for (let i = 0; i < totalItemsToProcess; i += BATCH_SIZE) {
    batches.push(itemsToProcess.slice(i, i + BATCH_SIZE));
  }
  logInfo(`Divided ${totalItemsToProcess} items into ${batches.length} batches of size ${BATCH_SIZE}.`);

  // 4. AIバッチ処理の並列実行
  let completedBatchCount = 0; // ★ 競合しないように完了バッチ数をカウント
  const allResults = new Map(); // Map<originalIndex, aiResult>

  const batchPromises = batches.map(async (batch, batchIndex) => {
    const batchTitles = batch.map(item => item.title);
    
    // AI処理実行
    const aiResults = await processBatchWithAI(batchTitles, batchIndex + 1);

    // 結果を元のインデックスと紐付け
    batch.forEach((item, idx) => {
      allResults.set(item.originalIndex, aiResults[idx] || {});
    });

    // ★ ログ修正
    completedBatchCount++; // 完了バッチ数をインクリメント
    let processedCount = completedBatchCount * BATCH_SIZE; // おおよその処理済み件数を計算

    // 最後のバッチの場合、端数を考慮して合計件数に合わせる
    if (completedBatchCount === batches.length) {
        processedCount = totalItemsToProcess;
    }

    logInfo(`[Progress] Batch ${batchIndex + 1}/${batches.length} complete. Total processed approx: ${processedCount}/${totalItemsToProcess} (Completed batches ${completedBatchCount}/${batches.length})`);
  });

  try {
    await Promise.all(batchPromises);
    // ★ ログ修正: 最終的な件数をMapのサイズから取得
    logInfo(`All AI batches completed. Total items processed: ${allResults.size}`);
  } catch (batchError) {
    logError("Error during parallel batch processing:", batchError);
    // エラーが発生しても、処理できた分だけで続行する（エラー内容はAI結果に含まれる）
  }

  // 5. 元データとAI結果のマージ
  // ★ ログ修正: Mapのサイズを使用
  logInfo(`Merging ${allResults.size} AI results into original CSV data...`);
  let mergeCount = 0;
  allResults.forEach((aiRow, originalIndex) => {
    if (fullCsvData[originalIndex]) {
      // 既存のデータを上書きしないようにチェック (空の場合のみAIの結果で埋める)
      fullCsvData[originalIndex][3] = (fullCsvData[originalIndex][3] || "").trim() === "" ? aiRow.country_of_origin : fullCsvData[originalIndex][3];
      
      // ★★★ 構文エラー修正点 ★★★
      fullCsvData[originalIndex][4] = (fullCsvData[originalIndex][4] || "").trim() === "" ? aiRow.artist : fullCsvData[originalIndex][4];
      fullCsvData[originalIndex][5] = (fullCsvData[originalIndex][5] || "").trim() === "" ? aiRow.release_title : fullCsvData[originalIndex][5];
      // ★★★ 修正ここまで ★★★
      
      mergeCount++;
    } else {
      logWarn(`Could not find original row data for index: ${originalIndex}`);
    }
  });
  logInfo(`Merging complete. Merged ${mergeCount} items.`); // ★ この件数は allResults.size と一致するはず

  // 6. CSV文字列に変換してクライアントに返送
  logInfo("Unparsing data back to CSV string.");
  const outputCsvString = Papa.unparse(fullCsvData);

  logInfo("Sending processed CSV file back to client.");
  // クライアント側でファイルとしてダウンロードさせるためのヘッダー設定
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="processed_catalog.csv"');
  // BOM (バイトオーダーマーク) を先頭に追加 (Excelでの文字化け対策)
  const bom = '\uFEFF';
  res.status(200).send(bom + outputCsvString);
});

// サーバー起動
app.listen(port, () => {
  logInfo(`サーバーがポート ${port} で起動しました`);
});
