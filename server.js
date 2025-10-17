require('dotenv').config();
const express = require('express');
const path = require('path');
const { OpenAI } = require('openai');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// APIキーのチェック
if (!process.env.OPENAI_API_KEY) {
  // ★ ログ追加: 起動時にAPIキーがない場合、Renderログにエラーを出力
  console.error("エラー: OPENAI_API_KEY が .env ファイルに設定されていません。");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ミドルウェアの設定
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ルートエンドポイント
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// APIエンドポイント (AI処理)
app.post('/api/process', async (req, res) => {
  const { titles } = req.body;
  // ★ ログ用: バッチサイズを取得
  const batchSize = titles ? titles.length : 0;

  // ★ ログ追加: リクエスト受信
  console.log(`[Server] Received API request for ${batchSize} titles.`);

  if (!titles || !Array.isArray(titles) || titles.length === 0) {
    // ★ ログ追加: 不正なリクエスト
    console.warn('[Server] Invalid request: Titles list is missing or empty.');
    return res.status(400).json({ error: '処理対象のタイトルリストが必要です。' });
  }

  // OpenAIへのリクエスト用プロンプトを構築
  const userPrompt = `
以下のリストは、商品タイトルの文字列リストです。
${JSON.stringify(titles, null, 2)}
リスト内の各タイトル文字列について、以下のタスクを実行してください。

アーティスト名 (artist):
文字列から最も可能性の高いアーティスト名を英語で特定します。
一般的なスペルミス（例: "Doubie Brothers"）は "The Doobie Brothers" のように修正します。
リリースタイトル (release_title):
文字列から正確なアルバム名やシングル名を英語で特定します。
"CD", "Used", "Vinyl", "with Sleeve" などのステータスやフォーマットに関する余分な情報は削除します。
原産国 (country_of_origin):
まず、タイトル文字列内に国名（例: "Japan", "UK", "US"）が明記されているか確認し、あればそれを採用します。
タイトル内に情報がない場合は、アーティスト名やリリースタイトル、型番（例: WPCR-2653）などを基に、そのリリースの主な製造国または販売国を推測します。
特定が困難な場合は "Unknown" としてください。
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

  try {
    // ★ ログ追加: AI呼び出し開始
    console.log(`[Server] Calling OpenAI API for ${batchSize} titles...`);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "あなたは、音楽メディア（CD、レコードなど）の商品タイトル情報を解析するエキスパートAIです。提供されたテキスト文字列のリストを分析し、各項目から「アーティスト名」「リリースタイトル」「原産国」を正確に抽出するタスクを実行します。"
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      response_format: { type: "json_object" },
    });

    // ★ ログ追加: AI応答受信
    console.log(`[Server] Received response from OpenAI for ${batchSize} titles.`);
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
                 // ★ ログ追加
                console.warn("[Server] AI response was an object but did not contain an array.", parsedResponse);
                aiData = [];
            }
        } else {
             // ★ ログ追加
             console.warn("[Server] AI response was not an array or object.", parsedResponse);
             aiData = [];
        }

    } catch (e) {
        // ★ ログ追加: パース失敗
        console.error("[Server] Failed to parse AI response:", responseContent, e.message);
        aiData = [];
    }

    if (aiData.length === 0 && titles.length > 0) {
        // ★ ログ追加: 空の応答
        console.warn(`[Server] Warning: AI returned an empty array for ${titles.length} requested items.`);
    } else if (aiData.length !== titles.length) {
        // ★ ログ追加: 件数不一致
        console.warn(`[Server] Warning: AI response count (${aiData.length}) does not match request count (${titles.length}).`);
    }

    // ★ ログ追加: フロントエンドへの応答
    console.log(`[Server] Sending ${aiData.length} processed items back to client.`);
    res.json(aiData);

  } catch (error) {
    // OpenAI API自体との通信エラー（キー間違い、レート制限など）
    // ★ ログ追加: API通信エラー詳細
    console.error('[Server] OpenAI API Error:', error.status, error.message);
    // エラーでも空配列を返し、フロントの処理を継続させる
    res.status(200).json([]);
  }
});

// サーバー起動
app.listen(port, () => {
  // ★ ログ変更: localhostではなく Render のポート番号を表示
  console.log(`サーバーがポート ${port} で起動しました`);
});
