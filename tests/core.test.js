  const realLines = Core.buildCaptionLines(realRepeatedSpeech, { reliable: false, intervals: [] }, 40);
  assert.equal(realLines.length, 4);

  const loopThenNewSpeech = [
    ...Array.from({ length: 8 }, (_, i) => ({ text: 'Thank you.', start: i * 2, end: i * 2 + 1.8 })),
    { text: 'Welcome back.', start: 17, end: 18.5 }
  ];
  const afterLoop = Core.buildCaptionLines(loopThenNewSpeech, { reliable: false, intervals: [] }, 20);
  assert.equal(afterLoop.length, 2);
  assert.equal(afterLoop[1].text, 'Welcome back.');
  assert.ok(afterLoop[1].start >= 17);
});