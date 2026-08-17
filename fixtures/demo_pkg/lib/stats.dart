/// Mean of [values]. Returns 0 when there is nothing to average.
double average(List<int> values) {
  return values.reduce((a, b) => a + b) / values.length;
}
