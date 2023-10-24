import { Jsonnet } from "@hanazuki/node-jsonnet";
import * as path from 'path';
import { OpenAiEndpoint } from 'src/lib/OpenAiEndpoint';
import { PostgresClient } from 'src/lib/PostgresClient';

enum PostgresDistanceMetric {
  COSINE = 'COSINE',
  IP = 'IP',
  L2 = 'L2'
}

const gpt3endpoint = new OpenAiEndpoint("https://api.openai.com/v1/chat/completions",
                                        "",
                                        "",
                                        "gpt-3.5-turbo",
                                        "user",
                                        0.7);

export async function hydeSearchAdaEmbedding(arkRequest){
  try {
    // Get required params from API...
    const table = 'ada_hyde_prod';
    const namespace = '360_docs';
    const query = arkRequest.query;
    const topK = Number(arkRequest.topK);

    //
    const jsonnet = new Jsonnet();

    const promptPath = path.join(process.cwd(),'./src/hydeExample/prompts.jsonnet')
    const hydePath = path.join(process.cwd(),'./src/hydeExample/hyde.jsonnet')
    // Load Jsonnet to extract args..
    var promptLoader = await jsonnet
                            .evaluateFile(promptPath);

    // Getting ${summary} basePrompt
    const promptTemplate = JSON.parse(promptLoader).summary;

    // Getting the updated promptTemplate with query
    var hydeLoader = await jsonnet
                        .extString('promptTemplate',promptTemplate)
                        .extString('time',"")
                        .extString('query',query)
                        .evaluateFile(hydePath);

    // Get concatenated prompt
    const prompt = JSON.parse(hydeLoader).prompt;

    // Block and get the response from GPT3
    const gptResponse = await gpt3endpoint.gptFn(prompt);

    // Chain 1 ==> Get Gpt3Response & split
    const gpt3Responses = gptResponse.split('\n');

    // Chain 2 ==> Get Embeddings from OpenAI using Each Response
    const embeddingsListChain: Promise<Number[][]> = Promise.all(
      gpt3Responses.map(async (resp) => {
        const embedding = await gpt3endpoint.embeddings(resp);
        return embedding;
      })
    );

    // Chain 5 ==> Query via EmbeddingChain
    const dbClient = new PostgresClient(await embeddingsListChain, PostgresDistanceMetric.IP, topK, 20,table,namespace,arkRequest,15);
    const queryResult = await dbClient.dbQuery();

    // Chain 6 ==> Create Prompt using Embeddings
    const retrievedDocs: string[] = [];

    for (const embeddings of queryResult) {
      retrievedDocs.push(
        `${embeddings.raw_text}\n score:${embeddings.score}\n filename:${embeddings.filename}\n`
      );
    }
  
    if (retrievedDocs.join('').length > 4096) {
      retrievedDocs.length = 4096;
    }

    const currentTime = new Date().toLocaleString();
    const formattedTime = currentTime;

    // System prompt
    const ansPromptSystem = JSON.parse(promptLoader).ans_prompt_system 
    
    hydeLoader = await jsonnet
                            .extString(promptTemplate,ansPromptSystem)
                            .extString('time',formattedTime)
                            .extString('qeury',retrievedDocs.join(''))
                            .evaluateFile(hydePath);

    const finalPromptSystem = JSON.parse(hydeLoader).prompt;

    // User prompt
    const ansPromptUser = JSON.parse(promptLoader).ans_prompt_user
    
    hydeLoader = await jsonnet
                            .extString(promptTemplate,ansPromptUser)
                            .extString('qeury',query)
                            .evaluateFile(hydePath);
    const finalPromptUser = JSON.parse(hydeLoader).prompt;;

    const chatMessages = [
      { 'role': 'system', 'content': finalPromptSystem },
      { 'role': 'user', 'content': finalPromptUser },
    ];

    const finalAnswer = await gpt3endpoint.gptFnChat(chatMessages);

    const response = {
      wordEmbeddings: queryResult,
      finalAnswer: finalAnswer,
    };

    return response;
  } catch (error) {
    // Handle errors here
    console.error(error);
    throw error;
  }
}
