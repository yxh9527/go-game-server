// The packaged MultyBetGglRoomItem dispatches 6231 by faceValue alone. Both
// scratch games share denominations and one socket; match the server's roomId
// before dispatching so concurrent rows cannot consume another game's ticket.
export function adaptScratchMultiResponse(source) {
  const method = /([\w$]+)\['prototype'\]\['onResponse'\]=function\(([\w$]+)\)\{var ([\w$]+);this\['log'\]\('onResponse',\2\['faceValue'\]\/0x64,\2\),/g;
  return source.replace(method, (matched, _class, response) => matched.replace('{var ',
    `{if(Number(${response}['roomId'])!==Number(this['roomId']))return;var `));
}
