import { parse } from '@shared/jpdb/parse';
import { JPDBCard, JPDBRawToken, JPDBRawVocabulary, JPDBToken } from '@shared/jpdb/types';
import { Batch } from './parser.types';
import { getPitchClass } from './pitch-accent-utils';
import { getConfiguration } from '@shared/configuration/get-configuration';

export class Parser {
  constructor(private batch: Batch) {}

  public async parse(): Promise<void> {
    // Load known readings
    let readingMap: Record<string, string[]> = {};
    try {
      readingMap = JSON.parse(await getConfiguration("knownReadings"));
    } catch {}

    const paragraphs = this.batch.strings;
    const { tokens, vocabulary } = await parse(paragraphs);

    const cards = this.vocabToCard(vocabulary);
    const parsedTokens = this.parseTokens(tokens, cards, readingMap);

    this.addSentenceInfo(paragraphs, parsedTokens);

    for (const [i, handle] of this.batch.handles.entries()) {
      handle.resolve(parsedTokens[i]);
    }
  }

  private vocabToCard(vocabulary: JPDBRawVocabulary[]): JPDBCard[] {
    return vocabulary.map((vocab) => {
      const [
        vid,
        sid,
        rid,
        spelling,
        reading,
        frequencyRank,
        partOfSpeech,
        meaningsChunks,
        meaningsPartOfSpeech,
        cardState,
        pitchAccent,
      ] = vocab;

      return {
        vid,
        sid,
        rid,
        spelling,
        reading,
        frequencyRank,
        partOfSpeech,
        meanings: meaningsChunks.map((glosses, i) => ({
          glosses,
          partOfSpeech: meaningsPartOfSpeech[i],
        })),
        cardState: cardState?.length ? cardState : ['not-in-deck'],
        pitchAccent: pitchAccent ?? [],
        wordWithReading: null,
      };
    });
  }

  private parseTokens(tokens: JPDBRawToken[][], cards: JPDBCard[], 
      readingMap: Record<string, string[]>): JPDBToken[][] {
    return tokens.map((innerTokens) => {
      let lastPitchClass = '';

      return innerTokens.map((token) => {
        const [vocabularyIndex, position, length, furigana] = token;
        const card = cards[vocabularyIndex];

        let offset = position;

        const rubies =
          furigana === null
            ? []
            : furigana.flatMap((part) => {
                if (typeof part === 'string') {
                  offset += part.length;

                  return [];
                }

                const [base, ruby] = part;
                const start = offset;
                const length = base.length;
                const end = (offset = start + length);

                return { text: ruby, start, end, length };
              });

        const isParticle = card.partOfSpeech.includes('prt');
        const pitchClass = isParticle ? '' : getPitchClass(card.pitchAccent, card.reading);

        lastPitchClass = pitchClass || lastPitchClass;

        // Determine readability by checking membership of kanji in reading map
        let readable = true;
        for (let i = 0; i < rubies.length; i++) {
          let pos = rubies[i].start - position;
          let kanji = card.spelling.slice(pos, pos + rubies[i].length);
          if (!(kanji in readingMap) || !readingMap[kanji].includes(rubies[i].text)) {
            readable = false;
            break;
          }
        }

        const result: JPDBToken = {
          card,
          start: position,
          end: position + length,
          length: length,
          rubies,
          pitchClass: lastPitchClass,
          readable,
        };

        this.assignWordWithReading(result);

        return result;
      });
    });
  }

  private assignWordWithReading(token: JPDBToken): void {
    const { card, rubies: ruby, start: offset } = token;
    const { spelling: kanji } = card;

    if (!ruby.length) {
      return;
    }

    const word = kanji.split('');

    for (let i = ruby.length - 1; i >= 0; i--) {
      const { text, start, length } = ruby[i];

      word.splice(start - offset + length, 0, `[${text}]`);
    }

    card.wordWithReading = word.join('');
  }

  private addSentenceInfo(paragraphs: string[], tokens: JPDBToken[][]): void {
    paragraphs.forEach((paragraph, i) => {
      const tokenData = tokens[i];
      const sentences = this.splitJapaneseTextIntoSentences(paragraph);

      if (sentences.length === 1) {
        tokenData.forEach((token) => {
          token.sentence = sentences[0];
        });

        return;
      }

      let offset = 0;

      for (const sentence of sentences) {
        const compareSentence = sentence.replace(/(^[「『])|([。！？」』]$)/g, ''); // Trim quotation marks and sentence-ending punctuation from start and end
        const positionInParagraphs = paragraph.substring(offset).indexOf(compareSentence);

        if (positionInParagraphs === -1) {
          offset += sentence.length;

          return;
        }

        const sentenceStart = offset + positionInParagraphs;
        const sentenceEnd = sentenceStart + sentence.length;

        for (const token of tokenData) {
          if (token.start >= sentenceStart && token.end <= sentenceEnd) {
            token.sentence = sentence;
          }
        }

        offset += sentence.length;
      }
    });
  }

  private splitJapaneseTextIntoSentences(text: string): string[] {
    // Regular expression to match sentence-ending punctuation marks and quotation marks
    const sentenceEndRegex = /.*?[。！？」』](?=\s?|$)|「.*?」|『.*?』/g;
    const sentences = text.match(sentenceEndRegex) || [];

    return sentences.length
      ? sentences
          .map((sentence) => sentence.trim())
          .filter(Boolean)
          .filter((sentence) => !/^[」』]$/.exec(sentence))
          .map((sentence) => {
            // If the sentence is a quotation, return it as is
            if (/「.*?」|『.*?』/.exec(sentence)) {
              return sentence;
            }

            // If a quotation contained multiple sentences, remove the quotation marks
            const trimmed = sentence.replace(/(^「|『)|(」|』$)/, '');

            // Add a period at the end of the sentence if it doesn't already have a sentence-ending punctuation mark
            return /[。！？]$/.exec(trimmed) ? trimmed : `${trimmed}。`;
          })
      : [text];
  }
}
