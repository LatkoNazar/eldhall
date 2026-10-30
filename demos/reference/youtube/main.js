// Hyperframes owns media time. This module only builds a seekable visual timeline.
window.buildRootTimeline = (duration) => {
  const timeline = gsap.timeline({paused: true});
  timeline.to({}, {duration, ease: 'none'}, 0);
  return timeline;
};
