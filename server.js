require('dotenv').config();
const express = require('express');
const path = require('path');
const { OpenAI } = require('openai');
const cors = require('cors');
const multer = require('multer'); // ★ ファイルアップロード用
const Papa = require('papaparse'); // ★ CSV解析用

const app = express();
const port = process.env.PORT || 3000;

// ★★★ 変更点 ★★★
const BATCH_SIZE = 50; // 100から50に変更
// ★★★ 変更ここまで ★★★

const MAX_PROCESS_LIMIT = 1000; // 最大処理件数を定数化

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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ルートエンドポイント
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ★★★ AI処理のコア関数 ★★★
async function processBatchWithAI(titles, batchIndex) {
  const batchSize = titles.length;
  logInfo(`[AI Batch ${batchIndex}] Calling OpenAI API for ${batchSize} titles...`);

  // ★★★ プロンプト修正点 (userPrompt) ★★★
  // ルールをより厳格化
  const userPrompt = `
以下のリストは、商品タイトルの文字列リストです。
${JSON.stringify(titles, null, 2)}
リスト内の各タイトル文字列について、以下のタスクを実行してください。

アーティスト名 (artist):
文字列から最も可能性の高いアーティスト名を英語で特定します。
スペルミス（例: "Doubie Brothers"）は "The Doobie Brothers" のように修正します。
もし特定が困難な場合でも、決して "Unknown" とは回答せず、元のタイトルから最も可能性の高い部分を抽出してください。

リリースタイトル (release_title):
文字列から正確なアルバム名やシングル名を英語で特定します。
"CD", "Used", "Vinyl", "LP", "with Sleeve", "Used" などのステータス、フォーマット、コンディションに関する余分な情報は削除します。
**最重要ルール:** もし余分な情報を削除した結果、タイトルが空白（空欄 `""`）になる場合は、**空白を絶対に返さず**、削除する前の**「元のタイトル文字列」をそのまま** `release_title` として返してください。
（例: タイトルが "Used CD" の場合、"Used" と "CD" を削除すると空白になるため、"Used CD" をそのまま返します）
**"Unknown" とは絶対に回答しないでください。**

原産国 (country_of_origin):
まず、タイトル文字列内に国名（例: "Japan", "UK", "US"）が明記されているか確認し、あればそれを採用します。
次に、アーティスト名や型番（例: WPCR-2653）からリリースの製造国を推測します。
**フォールバック:** 上記でも不明な場合、アーティストの主な活動国（例: The Beatles なら "UK"）を回答します。
**最終手段:** アーティスト名も不明で、すべての手がかりを使っても特定が困難な場合のみ "Unknown" としてください。

出力形式:
抽出した情報を、以下のJSONオブジェクトのリスト（配列）形式で出力してください。
**厳守:** 入力されたタイトルの件数と、出力するJSONオブジェクトの件数は、**必ず同一**にしてください。（入力が${batchSize}件なら、必ず${batchSize}件のJSONオブジェクトを返します）
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
          content: "あなたは、DiscogsやMusicBrainzの知識を持つ、音楽カタログ解析AIです。あなたの最優先タスクは、**絶対に空白（空欄）や安易なUnknownを返さない**ことです。提供されたリストを分析し、各項目から「アーティスト名」「リリースタイトル」「原産国」をデータベース検索のように正確に特定します。特にリリースタイトルが空白になりそうな場合は、代わりに元のタイトルを返すよう厳密に処理してください。"
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
      const errorResult = { country_of_origin: 'AI Error', artist: 'AI Error', release_title: 'AI Error' };
      while (aiData.length < titles.length) {
        aiData.push(errorResult);
      }
    }
    return aiData;

  } catch (error) {
    logError(`[AI Batch ${batchIndex}] OpenAI API Error:`, error);
    return new Array(titles.length).fill({
      country_of_origin: 'API Error',
      artist: 'API Error',
      release_title: 'API Error'
    });
  }
}

// ★★★ メインエンドポイント (変更なし) ★★★
app.post('/api/upload', upload.single('csv-file'), async (req, res) => {
  logInfo("Received file upload request.");

  if (!req.file) {
    logWarn("File upload failed: No file provided.");
    return res.status(400).json({ error: 'ファイルが提供されていません。' });
  }

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
  let itemsToProcess = [];
  for (let i = 1; i < fullCsvData.length; i++) {
    const row = fullCsvData[i];
    const title = row[1] ? row[1].trim() : "";
    const colD = row[3] ? row[3].trim() : "";
    const colE = row[4] ? row[4].trim() : "";
    const colF = row[5] ? row[5].trim() : "";
    
    if (title !== "" && (colD === "" || colE === "" || colF === "")) {
      itemsToProcess.push({ originalIndex: i, title: title });
    }
  }

  let totalItemsToProcess = itemsToProcess.length;
  logInfo(`Filtering complete. Found ${totalItemsToProcess} items to process.`);

  if (totalItemsToProcess > MAX_PROCESS_LIMIT) {
    logWarn(`Processing limit exceeded: ${totalItemsToProcess} items. Processing only the first ${MAX_PROCESS_LIMIT} items.`);
    itemsToProcess = itemsToProcess.slice(0, MAX_PROCESS_LIMIT);
    totalItemsToProcess = itemsToProcess.length;
  }

  if (totalItemsToProcess === 0) {
    logWarn("No items found for AI processing. Returning original file.");
    return res.status(400).json({ error: 'AIによる補完対象の行が見つかりませんでした。' });
  }
  
  // 3. バッチ処理の準備
  const batches = [];
  for (let i = 0; i < totalItemsToProcess; i += BATCH_SIZE) { // BATCH_SIZE は 50
    batches.push(itemsToProcess.slice(i, i + BATCH_SIZE));
  }
  logInfo(`Divided ${totalItemsToProcess} items into ${batches.length} batches of size ${BATCH_SIZE}.`); // ログに 20 batches と表示されるはず

  // 4. AIバッチ処理の並列実行
  let completedBatchCount = 0;
  const allResults = new Map(); 

  const batchPromises = batches.map(async (batch, batchIndex) => {
    const batchTitles = batch.map(item => item.title);
    
    const aiResults = await processBatchWithAI(batchTitles, batchIndex + 1);

    batch.forEach((item, idx) => {
      allResults.set(item.originalIndex, aiResults[idx] || {});
    });

    completedBatchCount++;
    let processedCount = completedBatchCount * BATCH_SIZE;
    if (completedBatchCount === batches.length) {
        processedCount = totalItemsToProcess;
    }

    logInfo(`[Progress] Batch ${batchIndex + 1}/${batches.length} complete. Total processed approx: ${processedCount}/${totalItemsToProcess} (Completed batches ${completedBatchCount}/${batches.length})`);
  });

  try {
    await Promise.all(batchPromises);
    logInfo(`All AI batches completed. Total items processed: ${allResults.size}`);
  } catch (batchError) {
    logError("Error during parallel batch processing:", batchError);
  }

  // 5. 元データとAI結果のマージ
  logInfo(`Merging ${allResults.size} AI results into original CSV data...`);
  let mergeCount = 0;
  allResults.forEach((aiRow, originalIndex) => {
    if (fullCsvData[originalIndex]) {
      
      fullCsvData[originalIndex][3] = (fullCsvData[originalIndex][3] || "").trim() === "" ? aiRow.country_of_origin : fullCsvData[originalIndex][3];
      fullCsvData[originalIndex][4] = (fullCsvData[originalIndex][4] || "").trim() === "" ? aiRow.artist : fullCsvData[originalIndex][4];
      fullCsvData[originalIndex][5] = (fullCsvData[originalIndex][5] || "").trim() === "" ? aiRow.release_title : fullCsvData[originalIndex][5];
      
      mergeCount++;
    } else {
      logWarn(`Could not find original row data for index: ${originalIndex}`);
    }
  });
  logInfo(`Merging complete. Merged ${mergeCount} items.`);

  // 6. CSV文字列に変換してクライアントに返送
  logInfo("Unparsing data back to CSV string.");
  const outputCsvString = Papa.unparse(fullCsvData);

  logInfo("Sending processed CSV file back to client.");
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="processed_catalog.csv"');
  const bom = '\uFEFF';
  res.status(200).send(bom + outputCsvString);
});

// サーバー起動
app.listen(port, () => {
  logInfo(`サーバーがポート ${port} で起動しました`);
});
