require('dotenv').config();
const express = require('express');
const path = require('path');
const { OpenAI } = require('openai');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// APIキーのチェック
if (!process.env.OPENAI_API_KEY) {
  console.error("エラー: OPENAI_API_KEY が .env ファイルに設定されていません。");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ミドルウェアの設定
app.use(cors()); // CORSを許可
app.use(express.json({ limit: '10mb' })); // リクエストボディのサイズ上限を増やす
app.use(express.static(path.join(__dirname)));

// ルートエンドポイント (index.htmlを配信)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// APIエンドポイント (AI処理)
app.post('/api/process', async (req, res) => {
  const { titles } = req.body;

  if (!titles || !Array.isArray(titles) || titles.length === 0) {
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
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
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

    // APIからのレスポンスをパース
    const responseContent = completion.choices[0].message.content;
    
    let aiData;
    try {
        const parsedResponse = JSON.parse(responseContent);
        
        if (Array.isArray(parsedResponse)) {
            aiData = parsedResponse;
        } else if (typeof parsedResponse === 'object' && parsedResponse !== null) {
            // オブジェクトの最初のキーの値が配列であるかチェック
            const firstKey = Object.keys(parsedResponse)[0];
            if (firstKey && Array.isArray(parsedResponse[firstKey])) {
                aiData = parsedResponse[firstKey];
            } else {
                throw new Error("AIのレスポンスが期待したJSON配列形式ではありません。");
            }
        } else {
             throw new Error("AIのレスポンスが期待したJSON配列形式ではありません。");
        }
        
    } catch (e) {
        console.error("AIレスポンスのパースに失敗:", responseContent, e.message);
        throw new Error("AIのレスポンスをJSONとして解釈できませんでした。");
    }


    if (aiData.length !== titles.length) {
        console.warn(`警告: AIの回答数(${aiData.length})がリクエスト数(${titles.length})と一致しません。`);
    }

    res.json(aiData);

  } catch (error) {
    console.error('OpenAI APIエラー:', error);
    res.status(500).json({ error: 'AI処理中にエラーが発生しました。' });
  }
});

// サーバー起動
app.listen(port, () => {
  console.log(`サーバーが http://localhost:${port} で起動しました`);
});
