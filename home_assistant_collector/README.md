# Soter Activity Collector

Sends an allowlisted set of movement, current, and power state changes from Home Assistant to the Soter normality service using outbound HTTPS only.

The app has no ingress, does not require router port forwarding, and uses Home Assistant's internal Supervisor API. Events are kept in a persistent SQLite queue until Firebase acknowledges them.
